-- The table's repository, set once by the owner, is where every connection reads the team's code and lands branches.
-- A connection uses it only when its person connected with that address or said yes to exactly that address in their
-- AI's window (use_repo), and their own folder knows it (the connection checks): never on the word of whoever may change
-- settings. In a person's own folder their Claude may push only there, unless they let it push anywhere
-- (push_anywhere, theirs alone). Each AI window shows what its connection reads.
alter table public.connections add column push_anywhere boolean not null default false;
grant select (push_anywhere) on public.connections to authenticated;
alter table public.connections add column use_repo text;
grant select (use_repo) on public.connections to authenticated;

-- Their yes to the table's repository as it is right now. A different address later needs a new yes.
create function public.set_use_repo(conn uuid, url text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c public.connections;
  now_repo text;
begin
  select * into c from public.connections where id = conn and revoked_at is null;
  if not found or c.member_id is distinct from public.my_member_id(c.table_id) then
    raise exception 'only its own person decides which repository their AI uses';
  end if;
  select repo_url into now_repo from public.table_code where table_id = c.table_id;
  if url is not null and url is distinct from now_repo then
    raise exception 'that is not the table''s repository any more; look again';
  end if;
  update public.connections set use_repo = url where id = conn;
end;
$$;
revoke all on function public.set_use_repo(uuid, text) from public, anon;
grant execute on function public.set_use_repo(uuid, text) to authenticated;

create function public.set_push_anywhere(conn uuid, on_ boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c public.connections;
begin
  select * into c from public.connections where id = conn and revoked_at is null;
  if not found or c.member_id is distinct from public.my_member_id(c.table_id) then
    raise exception 'only its own person decides where their AI may push';
  end if;
  update public.connections set push_anywhere = coalesce(on_, false) where id = conn;
end;
$$;
revoke all on function public.set_push_anywhere(uuid, boolean) from public, anon;
grant execute on function public.set_push_anywhere(uuid, boolean) to authenticated;

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
    -- A team AI that reads the code for a client's question reads it where the team keeps it. A client's own
    -- assistant is never told where the code is.
    return public.client_job_payload(j) || case when exists (select 1 from public.members mm where mm.id = c.member_id and mm.role <> 'client')
      then jsonb_build_object('repo', (select tc.repo_url from public.table_code tc where tc.table_id = j.table_id), 'use_repo', c.use_repo) else '{}'::jsonb end;
  end if;
  if j.kind = 'sandbox' then
    -- A client's copy is a branch of the team's repository too.
    return public.sandbox_job_payload(j) || jsonb_build_object('repo', (select tc.repo_url from public.table_code tc where tc.table_id = j.table_id), 'use_repo', c.use_repo);
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
    'effort', c.effort, 'fast', c.fast, 'mode', c.mode, 'in_folder', c.in_folder, 'push_anywhere', c.push_anywhere, 'use_repo', c.use_repo,
    -- Where the team shares its code, as the owner set it: the connection reads and lands work there when its own
    -- copy of the project knows that repository.
    'repo', (select tc.repo_url from public.table_code tc where tc.table_id = j.table_id),
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

CREATE OR REPLACE FUNCTION public.runner_report(token text, limits jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.connections := public.connection_for(token);
begin
  if runner_report.limits is null or jsonb_typeof(runner_report.limits) <> 'object' or octet_length(runner_report.limits::text) > 4000 then
    raise exception 'limits must be a small object';
  end if;
  update public.connections
     set limits = jsonb_build_object(
           'ai', coalesce(runner_report.limits ->> 'ai', c.limits ->> 'ai'),
           'plan', coalesce(left(runner_report.limits ->> 'plan', 40), c.limits ->> 'plan'),
           'model', coalesce(left(runner_report.limits ->> 'model', 60), c.limits ->> 'model'),
           'status', coalesce(runner_report.limits ->> 'status', c.limits ->> 'status'),
           -- The version of the connection itself, so its window shows it and an update can be seen to have taken.
           'version', case when runner_report.limits ->> 'version' ~ '^\d+\.\d+\.\d+$' then runner_report.limits ->> 'version' else c.limits ->> 'version' end,
           -- What it reads: the repository's address (only a plain one, never with a sign-in in it), the last part of
           -- its person's own folder, and whether the table's repository is one that computer knows.
           'reads', case when jsonb_typeof(runner_report.limits -> 'reads') = 'object' then jsonb_build_object(
               'repo', case when runner_report.limits -> 'reads' ->> 'repo' ~ '^(https://[A-Za-z0-9.-]+/[A-Za-z0-9/._~+-]{1,200}|git@[A-Za-z0-9.-]+:[A-Za-z0-9/._~+-]{1,200}|ssh://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9/._~+-]{1,200})$'
                 then runner_report.limits -> 'reads' ->> 'repo' end,
               'folder', case when runner_report.limits -> 'reads' ->> 'folder' ~ '^[^/\\]{1,80}$'
                 then public.hide_secrets(runner_report.limits -> 'reads' ->> 'folder') end,
               'known', coalesce(runner_report.limits -> 'reads' ->> 'known', 'true') <> 'false')
             else c.limits -> 'reads' end,
           -- Whether fast mode can serve this AI, as its Claude Code said, and why not.
           'fast', case when runner_report.limits ->> 'fast' in ('off', 'on', 'cooldown') then runner_report.limits ->> 'fast' else c.limits ->> 'fast' end,
           'fast_why', case when runner_report.limits ? 'fast' then left(nullif(regexp_replace(coalesce(runner_report.limits ->> 'fast_why', ''), '[^a-z_]', '', 'g'), ''), 40) else c.limits ->> 'fast_why' end,
           'models', case when jsonb_typeof(runner_report.limits -> 'models') = 'array' then coalesce((
             select jsonb_agg(left(v, 40)) from (
               select v from jsonb_array_elements_text(runner_report.limits -> 'models') v limit 12) picked), '[]'::jsonb)
             else coalesce(c.limits -> 'models', '[]'::jsonb) end,
           'windows', case when jsonb_typeof(runner_report.limits -> 'windows') = 'array' then coalesce((
             select jsonb_agg(jsonb_build_object(
                      'name', left(w ->> 'name', 20),
                      'used', least(greatest(coalesce((w ->> 'used')::numeric, 0), 0), 100),
                      'resets', w ->> 'resets'))
               from jsonb_array_elements(runner_report.limits -> 'windows') w
              where jsonb_typeof(w) = 'object'), '[]'::jsonb)
             else coalesce(c.limits -> 'windows', '[]'::jsonb) end),
         limits_at = now()
   where id = c.id;
end;
$function$
;

-- Setting the table's repository clears every yes given to another address: a yes is to one address, so an address
-- that changes and later changes back still needs a new yes.
CREATE OR REPLACE FUNCTION public.set_table_repo(t uuid, url text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  clean text := btrim(coalesce(url, ''));
begin
  if not public.may(t, 'settings') then
    raise exception 'only the team can say where the code is';
  end if;
  if clean = '' then
    delete from public.table_code where table_id = t;
  else
    if clean !~ '^(https://|ssh://|git@)[A-Za-z0-9@:/._~+-]{4,250}$' then
      raise exception 'that does not look like a repository address; it starts with https:// or git@';
    end if;
    -- A sign-in written into the address (https://name:token@...) would be kept and shown to the team: refused.
    if clean ~ '^(https|ssh)://[^/]*@' then
      raise exception 'that address has a sign-in in it; give it without the name or token before the @';
    end if;
    insert into public.table_code (table_id, repo_url) values (t, clean)
      on conflict (table_id) do update set repo_url = excluded.repo_url, updated_at = now();
  end if;
  update public.connections set use_repo = null where table_id = t and use_repo is distinct from nullif(clean, '');
  perform public.log_activity(t, public.my_member_id(t), 'table.repo_set', t, jsonb_build_object('set', clean <> ''));
end;
$function$
;
