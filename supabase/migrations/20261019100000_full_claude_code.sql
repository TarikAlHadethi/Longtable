-- Each person's AI at the table can run as their full Claude Code: their own settings, rules, MCP servers, skills and
-- commands, working in a git worktree of their own repository, with Claude Code's own permission prompts brought to
-- them in Longtable to allow or deny. It is their choice, per connection (`connections.full`), and off until they turn
-- it on.
--
-- Approvals: when their Claude asks to do something their own rules do not already allow, the connection asks here
-- (`runner_ask_approval`), the person answers on their screen (`decide_approval`), and the connection reads the answer
-- (`runner_approval`). Only that person sees or answers their own Claude's requests; nobody else at the table can.

alter table public.connections add column full_claude boolean not null default false;
grant select (full_claude) on public.connections to authenticated;

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables(id) on delete cascade,
  connection_id uuid not null references public.connections(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  tool text not null,
  summary text not null,
  status text not null default 'waiting' check (status in ('waiting', 'allowed', 'denied', 'expired')),
  always boolean not null default false,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index approvals_waiting on public.approvals (connection_id) where status = 'waiting';
alter table public.approvals enable row level security;
revoke all on public.approvals from anon, authenticated;
grant select on public.approvals to authenticated;
create policy "a person sees only their own AI's requests" on public.approvals for select
  using (member_id = public.my_member_id(table_id));

-- The person's own choice: their AI runs as their full Claude Code, or locked down to reading and editing.
create function public.set_full_claude(conn uuid, full_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  cn public.connections;
begin
  select * into cn from public.connections where id = conn and revoked_at is null for update;
  if not found or cn.member_id <> public.my_member_id(cn.table_id) then
    raise exception 'this is yours to set only for your own AI';
  end if;
  if cn.kind <> 'claude' then
    raise exception 'only a Claude can run as full Claude Code';
  end if;
  update public.connections set full_claude = coalesce(full_on, false) where id = conn;
end;
$$;
revoke all on function public.set_full_claude(uuid, boolean) from public, anon;
grant execute on function public.set_full_claude(uuid, boolean) to authenticated;

-- Each job running as full Claude Code gets a key of its own for asking: the approval server holds only that, never
-- the connection's device token, so a command the AI runs can at most ask about its own job, and only while it runs.
alter table public.jobs add column approval_key text;

create function public.runner_job_key(token text, job uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
  k text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not c.full_claude then
    raise exception 'this AI is not set to run as full Claude Code';
  end if;
  update public.jobs set approval_key = encode(extensions.digest(k, 'sha256'), 'hex')
   where id = job and member_id = c.member_id and table_id = c.table_id and status = 'running';
  if not found then
    raise exception 'that job is not running on this connection';
  end if;
  return k;
end;
$$;
revoke all on function public.runner_job_key(text, uuid) from public, authenticated;
grant execute on function public.runner_job_key(text, uuid) to anon;

-- The job whose key this is, while it runs on a connection set to full Claude Code.
create function public.job_for_key(key text)
returns public.jobs language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
begin
  select * into j from public.jobs
   where approval_key = encode(extensions.digest(coalesce(key, ''), 'sha256'), 'hex') and status = 'running';
  if not found or not exists (select 1 from public.connections cn join public.members m on m.id = cn.member_id
                               where cn.member_id = j.member_id and cn.table_id = j.table_id and cn.revoked_at is null
                                 and cn.full_claude and cn.kind = 'claude' and m.removed_at is null) then
    raise exception 'that key is not for a running job';
  end if;
  return j;
end;
$$;
revoke all on function public.job_for_key(text) from public, anon, authenticated;

-- The approval server asks its person: one request, for its own running job.
create function public.runner_ask_approval(key text, tool text, summary text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs := public.job_for_key(key);
  cn public.connections;
  a uuid;
begin
  select * into cn from public.connections where member_id = j.member_id and table_id = j.table_id and revoked_at is null and kind = 'claude'
   order by last_seen desc nulls last limit 1;
  if (select count(*) from public.approvals where job_id = j.id and status = 'waiting') >= 5
     or (select count(*) from public.approvals where connection_id = cn.id and status = 'waiting') >= 20
     or (select count(*) from public.approvals where connection_id = cn.id and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'too many requests are waiting for an answer';
  end if;
  insert into public.approvals (table_id, connection_id, member_id, job_id, tool, summary)
    values (j.table_id, cn.id, j.member_id, j.id, public.kept_line(tool, 80), public.hide_secrets(left(coalesce(summary, ''), 2000)))
    returning id into a;
  perform realtime.send(jsonb_build_object('table', 'approvals', 'record', jsonb_build_object('id', a, 'member_id', j.member_id)),
    'INSERT', 'team:' || j.table_id::text, true);
  return a;
end;
$$;
revoke all on function public.runner_ask_approval(text, text, text) from public, authenticated;
grant execute on function public.runner_ask_approval(text, text, text) to anon;

-- The approval server reads its person's answer. A request nobody answered in 10 minutes is expired (a no).
create function public.runner_approval(key text, a uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs := public.job_for_key(key);
  r public.approvals;
begin
  select * into r from public.approvals where id = a and job_id = j.id for update;
  if not found then
    raise exception 'no such request';
  end if;
  if r.status = 'waiting' and r.created_at < now() - interval '10 minutes' then
    update public.approvals set status = 'expired', decided_at = now() where id = a returning * into r;
    perform realtime.send(jsonb_build_object('table', 'approvals', 'record', jsonb_build_object('id', a, 'member_id', r.member_id)),
      'UPDATE', 'team:' || r.table_id::text, true);
  end if;
  return jsonb_build_object('status', r.status, 'always', r.always);
end;
$$;
revoke all on function public.runner_approval(text, uuid) from public, authenticated;
grant execute on function public.runner_approval(text, uuid) to anon;

-- The person answers: only their own AI's request, and only while it waits.
create function public.decide_approval(a uuid, allow boolean, always_allow boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.approvals;
begin
  select * into r from public.approvals where id = a for update;
  if not found or r.member_id <> public.my_member_id(r.table_id) then
    raise exception 'only the person whose AI asked can answer';
  end if;
  if r.status <> 'waiting' then
    raise exception 'this request was already answered';
  end if;
  if r.created_at < now() - interval '10 minutes' then
    raise exception 'this request is too old to answer; ask your Claude again';
  end if;
  update public.approvals set status = case when allow then 'allowed' else 'denied' end,
    always = allow and coalesce(always_allow, false), decided_at = now() where id = a;
  perform realtime.send(jsonb_build_object('table', 'approvals', 'record', jsonb_build_object('id', a, 'member_id', r.member_id)),
    'UPDATE', 'team:' || r.table_id::text, true);
end;
$$;
revoke all on function public.decide_approval(uuid, boolean, boolean) from public, anon;
grant execute on function public.decide_approval(uuid, boolean, boolean) to authenticated;

-- An approval a job no longer needs (it finished, failed or was stopped) stops waiting.
create function public.close_job_approvals()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('done', 'failed', 'skipped') and old.status is distinct from new.status then
    update public.approvals set status = 'expired', decided_at = now() where job_id = new.id and status = 'waiting';
    -- The job's key dies with it.
    update public.jobs set approval_key = null where id = new.id and approval_key is not null;
  end if;
  return null;
end;
$$;
create trigger jobs_close_approvals after update of status on public.jobs for each row execute function public.close_job_approvals();

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
     set status = 'running', attempts = attempts + 1, lease_until = now() + (case when j.kind in ('work', 'sandbox') then interval '12 minutes' when j.kind = 'listen' then interval '90 seconds' when j.kind = 'look' then interval '2 minutes' else interval '5 minutes' end),
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
    -- Whether what they point at may also be handed to the other AIs working on the same request.
    'share_paths', coalesce(q.member_id = c.member_id and c.open_paths and c.share_paths, false),
    -- What another person's AI read from their own computer and shared for this request. Never this AI's own.
    'materials', (select coalesce(jsonb_agg(jsonb_build_object('from', mem.display_name, 'name', rm.name, 'body', rm.body) order by rm.created_at), '[]'::jsonb)
                    from public.round_materials rm join public.members mem on mem.id = rm.member_id
                   where rm.question_id = q.id and rm.member_id <> c.member_id and mem.removed_at is null
                     and exists (select 1 from public.connections sc where sc.member_id = rm.member_id and sc.revoked_at is null
                                   and sc.open_paths and sc.share_paths)),
    -- What was attached to the message being answered, and to the few before it in the same chat.
    'attachments', (select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb) from (
                      select a.id, a.name, a.mime, a.size, a.kind, a.path, l.url, a.created_at, mem.display_name as "from"
                        from public.attachments a join public.attachment_links l on l.attachment_id = a.id
                        join public.messages am on am.id = a.message_id join public.members mem on mem.id = a.member_id
                       where am.chat_id = j.chat_id and am.created_at <= q.created_at and am.created_at > q.created_at - interval '2 hours'
                       order by a.created_at desc limit 8) x),
    -- A message that starts with "/" runs one of the asker's own AI's commands. Its name, and what it is for only to
    -- the asker's own AI (or for a command every Claude has built in): someone's own commands stay theirs.
    'command', (select jsonb_build_object('name', cmd ->> 'name', 'mine', q.member_id = c.member_id)
                       || case when q.member_id = c.member_id or cmd ->> 'kind' = 'builtin'
                               then jsonb_build_object('about', cmd ->> 'about') else '{}'::jsonb end
                  from public.connections ac, jsonb_array_elements(ac.commands) cmd
                 where ac.member_id = q.member_id and ac.revoked_at is null
                   and q.body ~ '^\s*/' and lower(cmd ->> 'name') = lower(substring(q.body from '^\s*/([A-Za-z0-9:_-]+)'))
                 order by ac.last_seen desc nulls last limit 1),
    -- The pages in this chat, with their newest HTML, so a page can be changed when asked.
    'pages', public.pages_for_job(j),
    -- The person's own choices for their AI's runs.
    'effort', c.effort, 'fast', c.fast,
    -- The person runs their AI as their full Claude Code (their own rules, approvals on their screen), and only for
    -- their own request: a teammate's or a client's message never drives their full Claude Code.
    'full', coalesce(c.kind = 'claude' and c.full_claude and q.member_id = c.member_id and j.kind not in ('intro', 'combine'), false),
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
$function$
;

update public.connect_release set version = '0.1.26', set_at = now();
