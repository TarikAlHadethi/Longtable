-- A client's own sandbox. The owner can give a client a copy of the product to change freely: what they ask for is
-- done there by the team's AI, on a branch of its own that is never the real product, and they try it at its own
-- address. The team looks at what changed and decides what to take. By default a client has none of this: only the
-- assistant that tells them what is going on and passes things to the team.
--
-- Everything about a sandbox is the team's to read. A client learns about their own through one function, and
-- nothing about anyone else's.

create table public.sandboxes (
  member_id uuid primary key references public.members (id) on delete cascade,
  table_id uuid not null references public.tables (id) on delete cascade,
  mode text not null default 'sandbox' check (mode in ('chat', 'sandbox')),
  branch text not null,
  url text check (url is null or char_length(url) <= 300),
  created_at timestamptz not null default now()
);
alter table public.sandboxes enable row level security;
revoke all on public.sandboxes from anon, authenticated;
grant select on public.sandboxes to authenticated;
create policy "the team sees the sandboxes" on public.sandboxes for select to authenticated using (public.is_team(table_id));
create trigger sandboxes_broadcast after insert or update on public.sandboxes
  for each row execute function public.broadcast_team_change();

-- One row a table: where the team's own version opens, how many changes a copy takes in a day, and which folders a
-- copy may change (empty means anywhere the built-in rules allow).
create table public.table_sandbox (
  table_id uuid primary key references public.tables (id) on delete cascade,
  preview_url text check (preview_url is null or char_length(preview_url) <= 300),
  cap integer not null default 20 check (cap between 1 and 200),
  paths text not null default '' check (char_length(paths) <= 600)
);
alter table public.table_sandbox enable row level security;
revoke all on public.table_sandbox from anon, authenticated;
grant select on public.table_sandbox to authenticated;
create policy "the team sees the sandbox settings" on public.table_sandbox for select to authenticated using (public.is_team(table_id));

create table public.sandbox_changes (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  words text not null check (char_length(btrim(words)) between 1 and 4000),
  status text not null default 'working' check (status in ('working', 'ready', 'nothing', 'passed', 'failed', 'stopped')),
  -- What the client reads, in plain words.
  summary text,
  -- What only the team reads.
  detail text,
  files jsonb not null default '[]'::jsonb,
  commit text,
  stale boolean not null default false,
  request_id uuid references public.requests (id) on delete set null,
  -- What the team made of it.
  verdict text check (verdict in ('take', 'differently', 'no')),
  note text check (note is null or char_length(note) <= 1000),
  decided_by uuid references public.members (id) on delete set null,
  decided_at timestamptz,
  task_id uuid references public.tasks (id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index sandbox_changes_member_idx on public.sandbox_changes (member_id, created_at desc);
create index sandbox_changes_working_idx on public.sandbox_changes (created_at) where status = 'working';
alter table public.sandbox_changes enable row level security;
revoke all on public.sandbox_changes from anon, authenticated;
grant select on public.sandbox_changes to authenticated;
create policy "the team sees the sandbox changes" on public.sandbox_changes for select to authenticated using (public.is_team(table_id));

alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check
  check (kind in ('answer', 'view', 'combine', 'intro', 'client', 'work', 'review', 'listen', 'look', 'plan', 'sandbox'));
alter table public.jobs add column change_id uuid references public.sandbox_changes (id) on delete cascade;
create index jobs_change_idx on public.jobs (change_id) where change_id is not null;
-- A task made from a sandbox change remembers where to look.
alter table public.tasks add column reference jsonb;

-- Live: the team hears the whole row; the client hears only that something of theirs moved, and asks for it.
create function public.broadcast_sandbox_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.broadcast_changes('team:' || new.table_id::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
  perform realtime.send(jsonb_build_object('table', 'sandbox_changes', 'record', jsonb_build_object('id', new.id, 'status', new.status)),
    tg_op, 'client:' || new.table_id::text || ':' || new.member_id::text, true);
  return null;
end;
$$;
revoke all on function public.broadcast_sandbox_change() from public, anon, authenticated;
create trigger sandbox_changes_broadcast after insert or update on public.sandbox_changes
  for each row execute function public.broadcast_sandbox_change();

-- The owner gives a client a sandbox, or takes it away. The branch is made once and kept.
create function public.set_client_sandbox(m uuid, enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  who public.members;
begin
  select * into who from public.members where id = m and removed_at is null;
  if not found or not public.is_owner(who.table_id) then
    raise exception 'only the owner decides what a client can do';
  end if;
  if who.role <> 'client' then
    raise exception 'a sandbox is for a client';
  end if;
  insert into public.sandboxes (member_id, table_id, mode, branch)
    values (m, who.table_id, case when enabled then 'sandbox' else 'chat' end, 'longtable/sandbox-'
      || coalesce(nullif(btrim(left(regexp_replace(lower(who.display_name), '[^a-z0-9]+', '-', 'g'), 30), '-'), ''), 'client')
      || '-' || left(m::text, 8))
    on conflict (member_id) do update set mode = excluded.mode;
  insert into public.table_sandbox (table_id) values (who.table_id) on conflict (table_id) do nothing;
  -- The client's page hears that what it can do has changed.
  perform realtime.send(jsonb_build_object('table', 'sandbox_changes', 'record', jsonb_build_object('id', m, 'status', 'mode')),
    'UPDATE', 'client:' || who.table_id::text || ':' || m::text, true);
  perform public.log_activity(who.table_id, public.my_member_id(who.table_id), case when enabled then 'sandbox.given' else 'sandbox.taken' end, m,
    jsonb_build_object('name', who.display_name));
end;
$$;
revoke all on function public.set_client_sandbox(uuid, boolean) from public, anon;
grant execute on function public.set_client_sandbox(uuid, boolean) to authenticated;

-- Where each version can be opened, how much a sandbox takes in a day, and which folders it may change. Addresses
-- are plain https ones; folders are plain paths.
create function public.set_sandbox_links(t uuid, ours text, cap integer, m uuid default null, theirs text default null, folders text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  ok constant text := '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$';
  clean text;
begin
  if not public.is_owner(t) then
    raise exception 'only the owner sets this';
  end if;
  if nullif(btrim(coalesce(ours, '')), '') is not null and btrim(ours) !~ ok then
    raise exception 'that is not an address that starts with https://';
  end if;
  if nullif(btrim(coalesce(theirs, '')), '') is not null and btrim(theirs) !~ ok then
    raise exception 'that is not an address that starts with https://';
  end if;
  if folders is not null then
    select coalesce(string_agg(f, ', '), '') into clean from (
      select btrim(btrim(x), '/') as f from regexp_split_to_table(folders, '[,\n]') x) y where f <> '';
    if clean ~ '[^A-Za-z0-9._/, -]' or clean ~ '(^|[/ ])\.\.([/, ]|$)' then
      raise exception 'folders are plain paths like apps/web/app, separated by commas';
    end if;
  end if;
  insert into public.table_sandbox (table_id, preview_url, cap, paths)
    values (t, nullif(left(btrim(coalesce(ours, '')), 300), ''), least(200, greatest(1, coalesce(cap, 20))), left(coalesce(clean, ''), 600))
    on conflict (table_id) do update set preview_url = excluded.preview_url, cap = least(200, greatest(1, coalesce(set_sandbox_links.cap, public.table_sandbox.cap))),
      paths = case when folders is null then public.table_sandbox.paths else excluded.paths end;
  if m is not null then
    update public.sandboxes set url = nullif(left(btrim(coalesce(theirs, '')), 300), '') where member_id = m and table_id = t;
  end if;
end;
$$;
revoke all on function public.set_sandbox_links(uuid, text, integer, uuid, text, text) from public, anon;
grant execute on function public.set_sandbox_links(uuid, text, integer, uuid, text, text) to authenticated;

-- What the client's page calls. With a sandbox and a team Claude that is on, the words are a change to try there.
-- With their own AI on, the words go to it. Otherwise straight to the team.
create or replace function public.client_say(t uuid, body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me public.members;
  words text := btrim(coalesce(body, ''));
  ai public.connections;
  sb public.sandboxes;
  line uuid;
  job uuid;
  seat uuid;
  change uuid;
  used integer;
  most integer;
begin
  -- One of this person's messages at a time, so two sent together cannot both slip under a limit.
  select * into me from public.members where table_id = t and user_id = auth.uid() and removed_at is null for update;
  if not found or me.role <> 'client' then
    raise exception 'only the client asks here';
  end if;
  if char_length(words) = 0 then
    raise exception 'ask for something';
  end if;
  if char_length(words) > 4000 then
    raise exception 'that is a lot for one message; keep it under 4,000 characters';
  end if;
  if public.client_said_lately(me.id) + (select count(*) from public.sandbox_changes c where c.member_id = me.id and c.created_at > now() - interval '1 hour')::integer >= 30 then
    raise exception 'that is a lot of requests in one hour, try again a little later';
  end if;

  select * into sb from public.sandboxes where member_id = me.id and mode = 'sandbox';
  if found then
    -- The team's Claude that speaks for the table, if it is on; else any of the team's Claudes that is.
    select cn.member_id into seat
      from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
     where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
     order by (cn.member_id = public.final_seat_now(t)) desc, cn.created_at limit 1;
    -- Every change counts against the day, whatever came of it: each one is a run of the team's AI.
    select count(*) into used from public.sandbox_changes c where c.member_id = me.id and c.created_at > now() - interval '24 hours';
    select coalesce((select ts.cap from public.table_sandbox ts where ts.table_id = t), 20) into most;
    if seat is not null and used < most then
      insert into public.sandbox_changes (table_id, member_id, words) values (t, me.id, words) returning id into change;
      insert into public.jobs (table_id, member_id, kind, change_id) values (t, seat, 'sandbox', change) returning id into job;
      return jsonb_build_object('change', change, 'left', most - used - 1);
    end if;
    -- The sandbox cannot take it right now. The words still reach the team, and the client is told why.
    return jsonb_build_object('request', public.pass_on_request(me.id, words, null, null, true),
      'why', case when seat is null then 'asleep' else 'full' end);
  end if;

  select * into ai from public.connections
   where member_id = me.id and revoked_at is null and last_seen > now() - interval '60 seconds'
   order by last_seen desc limit 1;
  if not found then
    return jsonb_build_object('request', public.pass_on_request(me.id, words, null, null, true));
  end if;
  insert into public.client_lines (table_id, member_id, who, body) values (t, me.id, 'client', words) returning id into line;
  insert into public.jobs (table_id, member_id, kind, line_id) values (t, me.id, 'client', line) returning id into job;
  return jsonb_build_object('line', line, 'job', job);
end;
$$;

-- The client's own view of their sandbox: their words, where each change stands, what the team made of it, and
-- where to try it. None of the team's part (files, the team's notes to itself, commits, the branch).
create function public.client_sandbox(t uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare
  me public.members;
  sb public.sandboxes;
begin
  select * into me from public.members where table_id = t and user_id = auth.uid() and removed_at is null;
  if not found or me.role <> 'client' then
    raise exception 'only the client has a sandbox';
  end if;
  select * into sb from public.sandboxes where member_id = me.id;
  return jsonb_build_object(
    'on', coalesce(sb.mode = 'sandbox', false),
    'url', sb.url,
    'left', greatest(0, coalesce((select ts.cap from public.table_sandbox ts where ts.table_id = t), 20)
              - (select count(*) from public.sandbox_changes c where c.member_id = me.id and c.created_at > now() - interval '24 hours')::integer),
    'changes', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'words', c.words, 'status', c.status, 'summary', c.summary,
                  'verdict', c.verdict, 'note', c.note, 'request_id', c.request_id, 'created_at', c.created_at, 'finished_at', c.finished_at)
                  order by c.created_at desc), '[]'::jsonb)
                  from (select * from public.sandbox_changes x where x.member_id = me.id order by x.created_at desc limit 60) c));
end;
$$;
revoke all on function public.client_sandbox(uuid) from public, anon;
grant execute on function public.client_sandbox(uuid) to authenticated;

-- What a sandbox job carries: the client's words, what they asked for there before, and where it may change things.
-- Nothing of the team's chats.
create function public.sandbox_job_payload(j public.jobs)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ch public.sandbox_changes;
  who public.members;
begin
  select * into ch from public.sandbox_changes where id = j.change_id;
  select * into who from public.members where id = ch.member_id;
  return jsonb_build_object(
    'job_id', j.id,
    'kind', 'sandbox',
    'table_name', (select name from public.tables where id = j.table_id),
    'me', (select display_name from public.members where id = j.member_id),
    'client', who.display_name,
    'words', ch.words,
    'branch', (select s.branch from public.sandboxes s where s.member_id = ch.member_id),
    'paths', coalesce((select ts.paths from public.table_sandbox ts where ts.table_id = j.table_id), ''),
    'earlier', (select coalesce(jsonb_agg(jsonb_build_object('words', left(c.words, 600), 'summary', left(coalesce(c.summary, ''), 400), 'status', c.status,
                  'verdict', c.verdict, 'note', c.note) order by c.created_at), '[]'::jsonb)
                  from (select * from public.sandbox_changes x where x.member_id = ch.member_id and x.id <> ch.id and x.status <> 'working'
                         order by x.created_at desc limit 12) c));
end;
$$;
revoke all on function public.sandbox_job_payload(public.jobs) from public, anon, authenticated;

-- A sandbox change whose job is gone without finishing is closed, so the client is never left looking at "being
-- built" for ever. A sandbox job is given up on only when its computer is really gone: one that is on and busy with
-- other work gets to it when that is done.
create function public.close_sandbox()
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.jobs set status = 'skipped', lease_until = null, error = 'its computer never picked it up'
   where kind = 'sandbox'
     and ((status = 'running' and lease_until < now() - interval '10 minutes')
       or (status = 'queued' and created_at < now() - interval '10 minutes'
           and not exists (select 1 from public.connections cn where cn.member_id = jobs.member_id and cn.revoked_at is null
                            and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds')));
  update public.sandbox_changes c
     set status = case when exists (select 1 from public.jobs j where j.change_id = c.id and j.error like 'stopped by %') then 'stopped' else 'failed' end,
         finished_at = now(),
         summary = case when exists (select 1 from public.jobs j where j.change_id = c.id and j.error like 'stopped by %')
                        then 'The team stopped this one.' else 'This one did not get done. Try it again in a while.' end
   where c.status = 'working' and c.created_at < now() - interval '20 seconds'
     and not exists (select 1 from public.jobs j where j.change_id = c.id and j.status in ('queued', 'running', 'waiting'));
end;
$$;
revoke all on function public.close_sandbox() from public, anon, authenticated;
select cron.schedule('longtable-close-sandbox', '10 seconds', 'select public.close_sandbox()');

-- The team's answer to a change. Taking it starts the team's own work on it, with the sandbox as the thing to look
-- at. The message that starts that work is the team's own fixed words: what the client wrote is kept beside the task
-- as something to read, never as an instruction from the team.
create function public.judge_change(change uuid, answer text, said text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  ch public.sandbox_changes;
  me uuid;
  who public.members;
  chat uuid;
  msg uuid;
  started jsonb;
  tk uuid;
begin
  select * into ch from public.sandbox_changes where id = change for update;
  if not found or not public.is_team(ch.table_id) then
    raise exception 'that is not yours to decide';
  end if;
  if answer not in ('take', 'differently', 'no') then
    raise exception 'take it, do it differently, or not this';
  end if;
  if ch.status <> 'ready' then
    raise exception 'there is nothing in that one to decide on';
  end if;
  if ch.verdict = 'take' then
    raise exception 'that one is already being taken';
  end if;
  me := public.my_member_id(ch.table_id);
  select * into who from public.members where id = ch.member_id;
  if answer = 'take' then
    select coalesce(tb.client_chat, (select c.id from public.chats c where c.table_id = ch.table_id and c.is_general))
      into chat from public.tables tb where tb.id = ch.table_id;
    perform set_config('longtable.asked', '1', true);
    insert into public.messages (table_id, chat_id, member_id, body)
      values (ch.table_id, chat, me, left('Build the change from ' || who.display_name || '''s sandbox properly, in the real code.'
        || coalesce(E'\n' || nullif(btrim(coalesce(said, '')), ''), ''), 8000))
      returning id into msg;
    started := public.start_round(ch.table_id, chat, msg, me, null, left('From ' || split_part(who.display_name, ' ', 1) || ': ' || regexp_replace(ch.words, '\s+', ' ', 'g'), 70));
    tk := nullif(started ->> 'task', '')::uuid;
    if tk is null then
      raise exception 'connect an AI first, then take it';
    end if;
    update public.tasks set reference = jsonb_build_object('branch', (select s.branch from public.sandboxes s where s.member_id = ch.member_id),
      'commit', ch.commit, 'client', who.display_name, 'words', ch.words) where id = tk;
  end if;
  update public.sandbox_changes
     set verdict = answer, note = nullif(left(btrim(coalesce(said, '')), 1000), ''), decided_by = me, decided_at = now(), task_id = coalesce(tk, task_id)
   where id = ch.id;
  perform public.log_activity(ch.table_id, me, 'sandbox.' || answer, ch.id, jsonb_build_object('client', who.display_name));
  return tk;
end;
$$;
revoke all on function public.judge_change(uuid, text, text) from public, anon;
grant execute on function public.judge_change(uuid, text, text) to authenticated;

create or replace function public.runner_claim(token text, lane text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
$$;

create or replace function public.runner_finish(token text, job uuid, answer text, info jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
  msg uuid;
  clean text := public.hide_secrets(left(coalesce(answer, ''), 8000));
  who text;
  kind_out text;
  meta jsonb;
  line public.client_lines;
  passing boolean;
  req uuid;
  act text;
  q public.messages;
  parts jsonb := '[]'::jsonb;
  p jsonb;
  target uuid;
  mine text;
  tk uuid;
  rnd uuid;
  ch public.sandbox_changes;
begin
  select round into rnd from public.jobs where id = job;
  if rnd is not null then
    perform pg_advisory_xact_lock(hashtext(rnd::text));
  end if;
  select * into j from public.jobs where id = job for update;
  if not found or j.member_id <> c.member_id or j.status <> 'running' then
    raise exception 'this job is not yours to finish';
  end if;

  if j.kind = 'client' then
    passing := coalesce((info ->> 'pass_on')::boolean, true) or btrim(clean) = '';
    select * into line from public.client_lines where id = j.line_id;
    if passing then
      req := public.pass_on_request(j.member_id, line.body, public.hide_secrets(left(coalesce(info ->> 'title', ''), 120)), line.id, false);
    end if;
    insert into public.client_lines (table_id, member_id, who, body, request_id)
      values (j.table_id, j.member_id, 'assistant',
              coalesce(nullif(btrim(left(clean, 4000)), ''), 'Passed on to the team. You will hear here what they decide.'), req)
      returning id into msg;
    update public.jobs
       set status = 'done', finished_at = now(), lease_until = null, usage = coalesce(info -> 'usage', '{}'::jsonb)
     where id = j.id;
    return msg;
  end if;

  -- A change in a client's sandbox. What the client reads is the plain summary; the files and the rest are the team's.
  if j.kind = 'sandbox' then
    select * into ch from public.sandbox_changes where id = j.change_id for update;
    if coalesce((info ->> 'pass_on')::boolean, false) then
      -- Not a change to try out: a question, or something only the team can do. It goes to the team as a request.
      req := public.pass_on_request(ch.member_id, ch.words, public.hide_secrets(left(coalesce(info ->> 'title', ''), 120)), null, false);
      update public.sandbox_changes
         set status = 'passed', request_id = req, finished_at = now(),
             detail = public.hide_secrets(left(coalesce(info ->> 'detail', ''), 4000)),
             summary = coalesce(nullif(btrim(left(clean, 1200)), ''), 'That one is for the team, so I passed it on. You will hear here what they decide.')
       where id = ch.id;
    elsif coalesce((info ->> 'changed')::boolean, false) then
      update public.sandbox_changes
         set status = 'ready', finished_at = now(), summary = left(clean, 1200),
             detail = public.hide_secrets(left(coalesce(info ->> 'detail', ''), 4000)),
             files = case when jsonb_typeof(info -> 'files') = 'array' then (select coalesce(jsonb_agg(left(f, 300)), '[]'::jsonb) from (select jsonb_array_elements_text(info -> 'files') f limit 80) x) else '[]'::jsonb end,
             commit = case when coalesce(info ->> 'commit', '') ~ '^[0-9a-f]{7,40}$' then info ->> 'commit' else null end,
             stale = coalesce((info ->> 'stale')::boolean, false)
       where id = ch.id;
    else
      update public.sandbox_changes
         set status = 'nothing', finished_at = now(),
             summary = coalesce(nullif(btrim(left(clean, 1200)), ''), 'Nothing was changed.'),
             detail = public.hide_secrets(left(coalesce(info ->> 'detail', ''), 4000))
       where id = ch.id;
    end if;
    update public.jobs
       set status = 'done', finished_at = now(), lease_until = null, usage = coalesce(info -> 'usage', '{}'::jsonb)
     where id = j.id;
    return null;
  end if;

  if j.kind = 'listen' then
    act := case when info ->> 'act' in ('reply', 'look', 'work') then info ->> 'act' else 'silent' end;
    update public.jobs
       set status = 'done', finished_at = now(), lease_until = null, usage = coalesce(info -> 'usage', '{}'::jsonb),
           outcome = jsonb_build_object('act', act)
     where id = j.id;
    select * into q from public.messages where id = j.question_id;
    if act = 'reply' and btrim(clean) <> '' then
      insert into public.messages (table_id, chat_id, member_id, body, by_ai, kind, meta)
        values (j.table_id, j.chat_id, j.member_id, left(clean, 1500), true, 'answer',
                jsonb_build_object('job', j.id, 'model', info ->> 'model', 'sources', '[]'::jsonb, 'part', 'reply'))
        returning id into msg;
      update public.jobs set result_message_id = msg where id = j.id;
    elsif act = 'look' then
      insert into public.jobs (table_id, chat_id, member_id, question_id, kind) values (j.table_id, j.chat_id, j.member_id, j.question_id, 'look');
    elsif act = 'work' and q.id is not null then
      -- A follow-up goes on with the task it belongs to; anything else is a new task with its own branch.
      select t2.id into tk from public.tasks t2 where t2.table_id = j.table_id and t2.id::text = coalesce(info ->> 'task', '');
      perform public.start_round(j.table_id, j.chat_id, q.id, q.member_id, tk, public.hide_secrets(left(coalesce(info ->> 'title', ''), 80)));
    end if;
    return msg;
  end if;

  if btrim(clean) = '' then
    raise exception 'an answer cannot be empty';
  end if;
  select display_name into who from public.members where id = j.member_id;
  kind_out := case when j.kind in ('view', 'work', 'review', 'plan') then 'view' when j.kind = 'intro' then 'intro' else 'answer' end;
  meta := jsonb_build_object(
    'job', j.id, 'round', j.round, 'read', info ->> 'read', 'model', info ->> 'model',
    'sources', coalesce(info -> 'sources', '[]'::jsonb),
    'how', public.hide_secrets(coalesce(info ->> 'how', '')),
    'confidence', info ->> 'confidence',
    'part', j.kind, 'stage', j.stage, 'task', j.task_id, 'ok', info -> 'ok', 'changed', info -> 'changed',
    'hidden', clean <> left(coalesce(answer, ''), 8000));
  if j.kind = 'combine' then
    meta := meta || jsonb_build_object('parts', (
      select coalesce(jsonb_agg(distinct v.member_id), '[]'::jsonb) from public.jobs v
       where v.round = j.round and v.kind in ('view', 'work', 'review') and v.status = 'done' and v.member_id <> j.member_id));
  end if;

  -- The plan: who does which part. A part goes to a person's Claude only when that Claude is on right now; anything
  -- handed to someone who is not there stays with the one who planned.
  if j.kind = 'plan' then
    mine := coalesce(info ->> 'mine', '');
    for p in select * from jsonb_array_elements(case when jsonb_typeof(info -> 'handoffs') = 'array' then info -> 'handoffs' else '[]'::jsonb end) loop
      continue when btrim(coalesce(p ->> 'what', '')) = '';
      select mem.id into target
        from public.members mem join public.connections cn on cn.member_id = mem.id
       where mem.table_id = j.table_id and mem.role in ('owner', 'developer') and mem.id <> j.member_id
         and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
         and (lower(mem.display_name) = lower(btrim(p ->> 'to')) or lower(mem.display_name) like lower(btrim(p ->> 'to')) || ' %')
       limit 1;
      if target is null then
        mine := left(btrim(mine || E'\n' || left(p ->> 'what', 4000)), 12000);
      elsif exists (select 1 from jsonb_array_elements(parts) e where e ->> 'member' = target::text) then
        parts := (select jsonb_agg(case when e ->> 'member' = target::text
                    then jsonb_set(e, '{brief}', to_jsonb(left((e ->> 'brief') || E'\n' || public.hide_secrets(left(p ->> 'what', 4000)), 8000))) else e end) from jsonb_array_elements(parts) e);
      else
        parts := parts || jsonb_build_object('member', target, 'brief', public.hide_secrets(left(p ->> 'what', 4000)));
      end if;
    end loop;
    if jsonb_array_length(parts) > 0 and nullif(btrim(mine), '') is not null then
      parts := jsonb_build_object('member', j.member_id, 'brief', public.hide_secrets(left(btrim(mine), 4000))) || parts;
    end if;
  end if;

  insert into public.messages (table_id, chat_id, member_id, body, by_ai, kind, meta)
    values (j.table_id, j.chat_id, j.member_id, clean, true, kind_out, meta)
    returning id into msg;

  if j.kind = 'intro' then
    insert into public.notes (table_id, member_id, kind, title, body)
      values (j.table_id, j.member_id, 'intro', who || '''s Claude', clean)
      on conflict (table_id, member_id) where kind = 'intro'
      do update set body = excluded.body, updated_at = now();
    if coalesce(btrim(info ->> 'summary'), '') <> '' then
      insert into public.notes (table_id, member_id, kind, title, body)
        values (j.table_id, j.member_id, 'summary', 'The project', public.hide_secrets(left(info ->> 'summary', 4000)))
        on conflict (table_id) where kind = 'summary' do nothing;
    end if;
  end if;

  update public.jobs
     set status = 'done', result_message_id = msg, finished_at = now(), lease_until = null,
         usage = coalesce(info -> 'usage', '{}'::jsonb),
         outcome = jsonb_build_object('changed', coalesce((info ->> 'changed')::boolean, false), 'ok', coalesce((info ->> 'ok')::boolean, true), 'parts', parts)
   where id = j.id;
  if j.round is not null and j.kind = 'combine' then
    update public.jobs set status = 'skipped', lease_until = null, error = 'the answer was already given'
     where round = j.round and id <> j.id and status in ('queued', 'running', 'waiting');
  end if;
  if j.task_id is not null and j.kind in ('answer', 'combine') then
    update public.tasks set status = 'done', finished_at = now(), result = public.hide_secrets(left(info ->> 'read', 200))
     where id = j.task_id and status = 'working'
       and not exists (select 1 from public.jobs o where o.task_id = j.task_id and o.id <> j.id and o.status in ('queued', 'running', 'waiting'));
  end if;
  if j.round is not null then
    perform public.release_rounds();
    perform public.advance_round(j.round);
  end if;
  perform public.log_activity(j.table_id, j.member_id, 'ai.' || j.kind, msg, jsonb_build_object('job', j.id));
  return msg;
end;
$$;

create or replace function public.github_event(t uuid, signature text, event text, payload text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  h public.github_hooks;
  p jsonb;
  line text;
  general uuid;
  owner_id uuid;
  ref text;
  n int;
begin
  select * into h from public.github_hooks where table_id = t;
  if not found or signature is null
     or signature <> 'sha256=' || encode(extensions.hmac(convert_to(coalesce(payload, ''), 'utf8'), convert_to(h.secret, 'utf8'), 'sha256'), 'hex') then
    return 'refused';
  end if;
  begin
    p := payload::jsonb;
  exception when others then
    return 'refused';
  end;
  update public.github_hooks set last_event_at = now(), repo = coalesce(p #>> '{repository,full_name}', repo) where table_id = t;

  if event = 'ping' then
    line := 'GitHub is connected' || coalesce(' to ' || (p #>> '{repository,full_name}'), '') || '.';
  elsif event = 'push' then
    ref := regexp_replace(coalesce(p ->> 'ref', ''), '^refs/heads/', '');
    if ref <> coalesce(p #>> '{repository,default_branch}', 'main') then
      return 'ignored';
    end if;
    n := jsonb_array_length(coalesce(p -> 'commits', '[]'::jsonb));
    if n = 0 then
      return 'ignored';
    end if;
    line := coalesce(p #>> '{pusher,name}', 'Someone') || ' pushed ' || n || case when n = 1 then ' commit' else ' commits' end
      || ' to ' || ref || ': ' || left(split_part(coalesce(p #>> '{head_commit,message}', ''), E'\n', 1), 140);
  elsif event = 'pull_request' then
    if p ->> 'action' = 'opened' then
      line := coalesce(p #>> '{pull_request,user,login}', 'Someone') || ' opened pull request #' || (p #>> '{pull_request,number}')
        || ': ' || left(coalesce(p #>> '{pull_request,title}', ''), 140);
    elsif p ->> 'action' = 'closed' and (p #>> '{pull_request,merged}')::boolean then
      line := 'Pull request #' || (p #>> '{pull_request,number}') || ' was merged: ' || left(coalesce(p #>> '{pull_request,title}', ''), 140);
    else
      return 'ignored';
    end if;
  elsif event = 'deployment_status' then
    if p #>> '{deployment_status,state}' = 'success'
       and coalesce(p #>> '{deployment_status,environment_url}', p #>> '{deployment_status,target_url}', '') ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' then
      update public.sandboxes s
         set url = left(coalesce(p #>> '{deployment_status,environment_url}', p #>> '{deployment_status,target_url}'), 300)
       where s.table_id = t
         and (s.branch = p #>> '{deployment,ref}'
              or exists (select 1 from public.sandbox_changes c where c.member_id = s.member_id and c.commit = p #>> '{deployment,sha}'));
      return case when found then 'noted' else 'ignored' end;
    end if;
    return 'ignored';
  elsif event = 'workflow_run' then
    if p ->> 'action' <> 'completed' or p #>> '{workflow_run,conclusion}' <> 'failure' then
      return 'ignored';
    end if;
    line := 'CI failed on ' || coalesce(p #>> '{workflow_run,head_branch}', 'a branch') || ': '
      || left(coalesce(p #>> '{workflow_run,name}', 'a workflow'), 80);
  else
    return 'ignored';
  end if;

  select c.id into general from public.chats c where c.table_id = t and c.is_general;
  select m.id into owner_id from public.members m where m.table_id = t and m.role = 'owner';
  insert into public.messages (table_id, chat_id, member_id, body, kind, meta)
    values (t, general, owner_id, public.hide_secrets(line), 'github', jsonb_build_object('event', event));
  return 'posted';
end;
$$;
