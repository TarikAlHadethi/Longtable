-- A person's AI may open a place on their own computer that they point at in their own message. On by default,
-- theirs to turn off; the connection decides what is never opened.

alter table public.connections add column open_paths boolean not null default true;

CREATE OR REPLACE FUNCTION public.runner_claim(token text, lane text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
  q public.messages;
  history jsonb;
  views jsonb := '[]'::jsonb;
  related jsonb := '[]'::jsonb;
  pinned jsonb;
begin
  select * into j from public.jobs
    where member_id = c.member_id
      and (status = 'queued' or (status = 'running' and lease_until < now()))
      and attempts < 3
      and (kind not in ('work', 'plan', 'sandbox') or c.kind = 'claude')
      and case lane when 'heavy' then kind in ('work', 'answer', 'sandbox') when 'light' then kind not in ('work', 'answer', 'sandbox')
               else kind in ('answer', 'view', 'combine', 'intro', 'client') end
    order by (kind in ('client', 'listen')) desc, (kind = 'sandbox'), (kind in ('combine', 'work', 'review')) desc, created_at
    limit 1
    for update skip locked;
  if not found then
    return null;
  end if;
  update public.jobs
     set status = 'running', attempts = attempts + 1, lease_until = now() + (case when j.kind in ('work', 'sandbox') then interval '12 minutes' else interval '5 minutes' end),
         connection_id = c.id, started_at = now()
   where id = j.id;
  if j.kind = 'client' then
    return public.client_job_payload(j);
  end if;
  if j.kind = 'sandbox' then
    return public.sandbox_job_payload(j);
  end if;
  select * into q from public.messages where id = j.question_id;

  select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb) into history from (
    select m.created_at, m.body, m.by_ai, m.kind = 'client' as client, mem.display_name as name
      from public.messages m join public.members mem on mem.id = m.member_id
     where m.chat_id = j.chat_id and m.kind in ('chat', 'answer', 'client')
       and m.created_at < coalesce(q.created_at, now()) and m.id <> coalesce(j.question_id, m.id)
     order by m.created_at desc
     limit 400
  ) x;

  if j.kind in ('combine', 'work', 'review', 'plan') then
    select coalesce(jsonb_agg(jsonb_build_object('name', mem.display_name, 'view', m.body, 'meta', m.meta) order by m.created_at), '[]'::jsonb)
      into views
      from public.messages m join public.members mem on mem.id = m.member_id
     where m.table_id = j.table_id and m.kind = 'view' and m.meta ->> 'round' = j.round::text;
  end if;

  if q.body is not null then
    select coalesce(jsonb_agg(x), '[]'::jsonb) into related from (
      select ch.name as chat, mem.display_name as name, m.by_ai, m.kind = 'client' as client, m.body,
             ts_rank(m.search, public.loose_query(q.body)) as rank
        from public.messages m
        join public.members mem on mem.id = m.member_id
        join public.chats ch on ch.id = m.chat_id
       where m.table_id = j.table_id and m.kind in ('chat', 'answer', 'client') and m.id <> q.id
         and m.search @@ public.loose_query(q.body)
         and m.id not in (select m2.id from public.messages m2 where m2.chat_id = j.chat_id order by m2.created_at desc limit 21)
       order by rank desc
       limit 5
    ) x;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('kind', n.kind, 'title', n.title, 'body', n.body) order by n.kind desc, n.created_at), '[]'::jsonb)
    into pinned from public.notes n where n.table_id = j.table_id;

  return jsonb_build_object(
    'job_id', j.id,
    'kind', j.kind,
    'table_name', (select name from public.tables where id = j.table_id),
    'chat_name', (select name from public.chats where id = j.chat_id),
    'me', (select display_name from public.members where id = c.member_id),
    'asker', (select display_name from public.members where id = q.member_id),
    -- Whether the one asking is this connection's own person, and has left on that their AI may open places on
    -- their own computer that they point at. Never true for anyone else's message.
    'own_paths', coalesce(q.member_id = c.member_id and c.open_paths, false),
    'question', q.body,
    'history', history,
    'views', views,
    'stage', j.stage,
    'brief', j.brief,
    'reference', (select tk.reference from public.tasks tk where tk.id = j.task_id),
    'task_title', (select tk.title from public.tasks tk where tk.id = j.task_id),
    'branch', (select tk.branch from public.tasks tk where tk.id = j.task_id),
    'team', (select coalesce(jsonb_agg(distinct mem.display_name), '[]'::jsonb)
               from public.connections cn join public.members mem on mem.id = cn.member_id and mem.role in ('owner', 'developer')
              where cn.table_id = j.table_id and cn.revoked_at is null and cn.kind = 'claude'
                and cn.last_seen > now() - interval '60 seconds' and cn.member_id <> c.member_id),
    -- Who is at the table, and what its clients have asked for that is still open: plain facts every AI here may
    -- need, the quick listener most of all.
    'people', (select coalesce(jsonb_agg(jsonb_build_object('name', mem.display_name, 'role', mem.role,
                 'ai', (select cn.kind from public.connections cn where cn.member_id = mem.id and cn.revoked_at is null
                          and cn.last_seen > now() - interval '60 seconds' order by cn.last_seen desc limit 1)) order by mem.created_at), '[]'::jsonb)
                 from public.members mem where mem.table_id = j.table_id and mem.removed_at is null),
    'requests', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
                   select mem.display_name as "from", left(r.title, 160) as title, r.status, r.created_at
                     from public.requests r join public.members mem on mem.id = r.member_id
                    where r.table_id = j.table_id and r.status not in ('done', 'decided')
                    order by r.created_at desc limit 15) x),
    'tasks', (select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb) from (
                select tk.id, tk.title, tk.status, tk.created_at, mem.display_name as asked_by,
                       (select ch.name from public.chats ch where ch.id = tk.chat_id) as chat
                  from public.tasks tk left join public.members mem on mem.id = tk.member_id
                 where tk.table_id = j.table_id and (tk.status = 'working' or tk.created_at > now() - interval '3 days')
                 order by tk.created_at desc limit 8) x),
    'worker', (select mem.display_name from public.jobs w join public.members mem on mem.id = w.member_id where w.round = j.round and w.kind = 'work' limit 1),
    'work_read', (select m.meta ->> 'read' from public.jobs w join public.messages m on m.id = w.result_message_id
                   where w.round = j.round and w.kind = 'work' and w.status = 'done' and coalesce((w.outcome ->> 'changed')::boolean, false)
                   order by w.stage desc limit 1),
    'related', related,
    'pinned', pinned);
end;
$function$;
