-- Step 5, the client's own AI. A client connects their own Claude or Codex, on their own plan. It answers what it
-- can from that client's own requests and what they were told, and passes the rest on to the team as a request;
-- when unsure, it passes it on. It never sees the team side or the code: its jobs carry
-- only that client's own rows, and the connection runs them in an empty folder with every tool off. If it is off,
-- fails, or takes too long, the client's words go to the team anyway, so nothing they say is lost.

-- The client's private chat with their own AI. The team never reads it; what is passed on becomes a request.
create table public.client_lines (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  who text not null check (who in ('client', 'assistant')),
  body text not null check (char_length(btrim(body)) between 1 and 8000),
  request_id uuid references public.requests (id) on delete set null,
  created_at timestamptz not null default now()
);
create index client_lines_member_idx on public.client_lines (member_id, created_at);
alter table public.client_lines enable row level security;
revoke all on public.client_lines from anon;
create policy "a client reads their own chat with their AI" on public.client_lines
  for select to authenticated using (member_id = public.my_member_id(table_id));

-- A request passed on from that chat points back at the client's line, so their page shows the words once.
alter table public.requests add column from_line uuid references public.client_lines (id) on delete set null;

-- Client jobs: no chat, one line. Only the person they belong to sees them; the team sees its own kinds.
alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in ('answer', 'view', 'combine', 'intro', 'client'));
alter table public.jobs alter column chat_id drop not null;
alter table public.jobs add column line_id uuid references public.client_lines (id) on delete cascade;
alter table public.jobs add constraint jobs_client_shape check ((kind = 'client') = (line_id is not null and chat_id is null));
drop policy "the team sees the jobs" on public.jobs;
create policy "the team sees the team's jobs, and each person their own" on public.jobs
  for select to authenticated
  using ((public.is_team(table_id) and kind <> 'client') or member_id = public.my_member_id(table_id));

-- Each person sees their own connections (a client sees whether their AI is on); the team sees everyone's.
create policy "each person sees their own connections" on public.connections
  for select to authenticated using (member_id = public.my_member_id(table_id));

-- Anyone at the table may connect Claude or Codex. A client's AI only ever gets client jobs.
create or replace function public.start_pairing(t uuid, ai_kind text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  raw text;
  me uuid := public.my_member_id(t);
begin
  if me is null then
    raise exception 'only people at this table can connect an AI';
  end if;
  if ai_kind not in ('claude', 'codex') then
    raise exception 'unknown kind of AI';
  end if;
  raw := upper(encode(extensions.gen_random_bytes(10), 'hex'));
  insert into public.pairings (table_id, member_id, kind, code_hash)
    values (t, me, ai_kind, encode(extensions.digest(raw, 'sha256'), 'hex'));
  return raw;
end;
$$;

-- Pairing tells the connection whose it is. Only a team member's Claude introduces itself (that reads the code).
create or replace function public.pair_connection(code text, device_label text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.pairings;
  token text;
  conn uuid;
  who public.members;
  tname text;
  general uuid;
begin
  select * into p from public.pairings
    where code_hash = encode(extensions.digest(upper(btrim(code)), 'sha256'), 'hex')
    for update;
  if not found or p.used_at is not null or p.expires_at < now() then
    raise exception 'this connect code is not valid any more; press Connect again';
  end if;
  update public.pairings set used_at = now() where id = p.id;
  update public.connections set revoked_at = now()
    where member_id = p.member_id and kind = p.kind and revoked_at is null;
  token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.connections (table_id, member_id, kind, token_hash, label, last_seen)
    values (p.table_id, p.member_id, p.kind, encode(extensions.digest(token, 'sha256'), 'hex'), left(btrim(coalesce(device_label, '')), 80), now())
    returning id into conn;
  select * into who from public.members where id = p.member_id;
  select name into tname from public.tables where id = p.table_id;
  select id into general from public.chats where table_id = p.table_id and is_general;
  if p.kind = 'claude' and who.role <> 'client' then
    insert into public.jobs (table_id, chat_id, member_id, kind) values (p.table_id, general, p.member_id, 'intro');
  end if;
  perform public.log_activity(p.table_id, p.member_id, 'connection.paired', conn, jsonb_build_object('kind', p.kind, 'name', who.display_name));
  return jsonb_build_object('token', token, 'table_id', p.table_id, 'table_name', tname,
    'member_id', p.member_id, 'member_name', who.display_name, 'kind', p.kind, 'role', who.role);
end;
$$;

create or replace function public.runner_hello(token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
begin
  return jsonb_build_object(
    'table_id', c.table_id,
    'table_name', (select name from public.tables where id = c.table_id),
    'member_id', c.member_id,
    'member_name', (select display_name from public.members where id = c.member_id),
    'role', (select role from public.members where id = c.member_id),
    'kind', c.kind);
end;
$$;

-- Ask the table: only the team's AIs are ever chosen. A client's AI never answers the team, so it never reads code.
create or replace function public.ask_table(c uuid, body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t uuid;
  me uuid;
  q uuid;
  seats uuid[];
  final uuid;
  offline text;
  online_seat uuid;
  r uuid := gen_random_uuid();
  s uuid;
begin
  select ch.table_id into t from public.chats ch where ch.id = c;
  if t is null or not public.is_team(t) then
    raise exception 'only the team can ask the table';
  end if;
  if char_length(btrim(coalesce(body, ''))) = 0 then
    raise exception 'ask something';
  end if;
  me := public.my_member_id(t);
  insert into public.messages (table_id, chat_id, member_id, body) values (t, c, me, btrim(body)) returning id into q;

  select array_agg(cn.member_id order by cn.created_at) into seats
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
   where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude';
  if seats is null then
    return jsonb_build_object('message_id', q, 'answered_by', null);
  end if;
  select cn.member_id into online_seat
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
   where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
   order by cn.created_at limit 1;

  select coalesce(tb.final_seat, (select m.id from public.members m where m.table_id = t and m.role = 'owner')), tb.when_final_offline
    into final, offline from public.tables tb where tb.id = t;
  if not (final = any (seats)) then
    final := coalesce(online_seat, seats[1]);
  elsif offline = 'next' and online_seat is not null and not exists (
      select 1 from public.connections cn where cn.member_id = final and cn.revoked_at is null and cn.kind = 'claude'
        and cn.last_seen > now() - interval '60 seconds') then
    final := online_seat;
  end if;

  if array_length(seats, 1) = 1 then
    insert into public.jobs (table_id, chat_id, member_id, question_id, kind) values (t, c, final, q, 'answer');
    perform public.log_activity(t, me, 'table.asked', q, jsonb_build_object('answered_by', final));
    return jsonb_build_object('message_id', q, 'answered_by', final);
  end if;

  foreach s in array seats loop
    if s <> final then
      insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round) values (t, c, s, q, 'view', r);
    end if;
  end loop;
  insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, status)
    values (t, c, final, q, 'combine', r, 'waiting');
  perform public.log_activity(t, me, 'table.asked', q, jsonb_build_object('answered_by', final, 'round', r));
  return jsonb_build_object('message_id', q, 'answered_by', final, 'round', r);
end;
$$;

-- Passing a client's words on to the team: a request, a client card in the team's chat, the first step of its
-- timeline, and (when no AI of theirs replied) a note back to them. One place, used by every path.
create function public.pass_on_request(m uuid, words text, title text, line uuid, ack boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me public.members;
  req uuid := gen_random_uuid();
  msg uuid;
  landing uuid;
  clean text := left(btrim(words), 4000);
  heading text := left(regexp_replace(btrim(coalesce(nullif(btrim(coalesce(title, '')), ''), words)), '\s+', ' ', 'g'), 120);
begin
  select * into me from public.members where id = m;
  select coalesce(tb.client_chat, (select ch.id from public.chats ch where ch.table_id = me.table_id and ch.is_general))
    into landing from public.tables tb where tb.id = me.table_id;
  insert into public.messages (table_id, chat_id, member_id, body, kind, meta)
    values (me.table_id, landing, me.id, clean, 'client', jsonb_build_object('request', req))
    returning id into msg;
  insert into public.requests (id, table_id, member_id, title, body, message_id, from_line)
    values (req, me.table_id, me.id, heading, clean, msg, line);
  if line is not null then
    update public.client_lines set request_id = req where id = line;
  end if;
  perform public.add_request_event(req, 'You asked');
  if ack then
    insert into public.client_updates (table_id, request_id, body)
      values (me.table_id, req, 'Passed on to the team. You will hear here what they decide.');
  end if;
  perform public.log_activity(me.table_id, me.id, 'client.asked', req, jsonb_build_object('title', heading));
  return req;
end;
$$;
revoke all on function public.pass_on_request(uuid, text, text, uuid, boolean) from public, anon, authenticated;

-- How much a client has said in the last hour, across both ways of saying it.
create function public.client_said_lately(m uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select ((select count(*) from public.requests r where r.member_id = m and r.from_line is null and r.created_at > now() - interval '1 hour')
        + (select count(*) from public.client_lines l where l.member_id = m and l.who = 'client' and l.created_at > now() - interval '1 hour'))::integer;
$$;
revoke all on function public.client_said_lately(uuid) from public, anon, authenticated;

-- Asking straight to the team, with no AI in between.
create or replace function public.client_ask(t uuid, body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me public.members;
  words text := btrim(coalesce(body, ''));
begin
  select * into me from public.members where table_id = t and user_id = auth.uid();
  if not found or me.role <> 'client' then
    raise exception 'only the client asks here';
  end if;
  if char_length(words) = 0 then
    raise exception 'ask for something';
  end if;
  if public.client_said_lately(me.id) >= 30 then
    raise exception 'that is a lot of requests in one hour, try again a little later';
  end if;
  return public.pass_on_request(me.id, words, null, null, true);
end;
$$;

-- What the client's page calls. With their AI on (heard from in the last minute) the words go to it; otherwise
-- straight to the team.
create function public.client_say(t uuid, body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me public.members;
  words text := btrim(coalesce(body, ''));
  ai public.connections;
  line uuid;
  job uuid;
begin
  select * into me from public.members where table_id = t and user_id = auth.uid();
  if not found or me.role <> 'client' then
    raise exception 'only the client asks here';
  end if;
  if char_length(words) = 0 then
    raise exception 'ask for something';
  end if;
  if char_length(words) > 4000 then
    raise exception 'that is a lot for one message; keep it under 4,000 characters';
  end if;
  if public.client_said_lately(me.id) >= 30 then
    raise exception 'that is a lot of requests in one hour, try again a little later';
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
revoke all on function public.client_say(uuid, text) from public, anon;
grant execute on function public.client_say(uuid, text) to authenticated;

-- What a client job carries: that client's own requests, their timelines, what they were told, and their recent
-- chat with their AI. Nothing of the team side, and no code.
create function public.client_job_payload(j public.jobs)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'job_id', j.id,
    'kind', 'client',
    'table_name', (select name from public.tables where id = j.table_id),
    'me', (select display_name from public.members where id = j.member_id),
    'question', (select body from public.client_lines where id = j.line_id),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'title', r.title, 'status', r.status, 'asked', r.created_at,
               'timeline', coalesce((select jsonb_agg(e.label order by e.id) from public.request_events e where e.request_id = r.id), '[]'::jsonb))
             order by r.created_at desc)
        from (select * from public.requests r2 where r2.member_id = j.member_id order by r2.created_at desc limit 30) r), '[]'::jsonb),
    'told', coalesce((
      select jsonb_agg(jsonb_build_object('when', u.created_at, 'words', u.body, 'their_answer', u.answer) order by u.created_at desc)
        from (select * from public.client_updates u2
               where u2.table_id = j.table_id
                 and (u2.request_id is null or exists (select 1 from public.requests r3 where r3.id = u2.request_id and r3.member_id = j.member_id))
               order by u2.created_at desc limit 30) u), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('who', l.who, 'body', l.body) order by l.created_at)
        from (select * from public.client_lines l2 where l2.member_id = j.member_id and l2.id <> j.line_id
               order by l2.created_at desc limit 20) l), '[]'::jsonb));
$$;
revoke all on function public.client_job_payload(public.jobs) from public, anon, authenticated;

-- When a client's AI cannot answer (it failed, or it is off), the words go to the team and the client is told.
create function public.give_up_client_job(job uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  line public.client_lines;
  req uuid;
begin
  select * into j from public.jobs where id = job and kind = 'client' for update;
  if not found or j.status in ('done', 'failed') then
    return;
  end if;
  update public.jobs set status = 'failed', error = left(coalesce(reason, ''), 500), lease_until = null, finished_at = now() where id = j.id;
  select * into line from public.client_lines where id = j.line_id;
  req := public.pass_on_request(j.member_id, line.body, null, line.id, false);
  insert into public.client_lines (table_id, member_id, who, body, request_id)
    values (j.table_id, j.member_id, 'assistant', 'Passed on to the team, since I could not answer that just now. You will hear here what they decide.', req);
end;
$$;
revoke all on function public.give_up_client_job(uuid, text) from public, anon, authenticated;

-- The runner takes the next job. A client job carries only that client's own rows.
create or replace function public.runner_claim(token text)
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
    order by (kind = 'client') desc, (kind = 'combine') desc, created_at
    limit 1
    for update skip locked;
  if not found then
    return null;
  end if;
  update public.jobs
     set status = 'running', attempts = attempts + 1, lease_until = now() + interval '5 minutes',
         connection_id = c.id, started_at = now()
   where id = j.id;
  if j.kind = 'client' then
    return public.client_job_payload(j);
  end if;
  select * into q from public.messages where id = j.question_id;

  select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb) into history from (
    select m.created_at, m.body, m.by_ai, m.kind = 'client' as client, mem.display_name as name
      from public.messages m join public.members mem on mem.id = m.member_id
     where m.chat_id = j.chat_id and m.kind in ('chat', 'answer', 'client')
       and m.created_at < coalesce(q.created_at, now()) and m.id <> coalesce(j.question_id, m.id)
     order by m.created_at desc
     limit 20
  ) x;

  if j.kind = 'combine' then
    select coalesce(jsonb_agg(jsonb_build_object('name', mem.display_name, 'view', m.body, 'meta', m.meta) order by m.created_at), '[]'::jsonb)
      into views
      from public.messages m join public.members mem on mem.id = m.member_id
     where m.kind = 'view' and m.meta ->> 'round' = j.round::text;
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
    'related', related,
    'pinned', pinned);
end;
$$;

-- The runner posts its work. A client job's reply goes into the client's chat with their AI; unless the AI is sure
-- it answered the question itself, the client's words also go to the team as a request.
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
begin
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

  if btrim(clean) = '' then
    raise exception 'an answer cannot be empty';
  end if;
  select display_name into who from public.members where id = j.member_id;
  kind_out := case j.kind when 'view' then 'view' when 'intro' then 'intro' else 'answer' end;
  meta := jsonb_build_object(
    'job', j.id, 'round', j.round, 'read', info ->> 'read', 'model', info ->> 'model',
    'sources', coalesce(info -> 'sources', '[]'::jsonb),
    'how', public.hide_secrets(coalesce(info ->> 'how', '')),
    'confidence', info ->> 'confidence',
    'hidden', clean <> left(coalesce(answer, ''), 8000));
  if j.kind = 'combine' then
    meta := meta || jsonb_build_object('parts', (
      select coalesce(jsonb_agg(distinct v.member_id), '[]'::jsonb) from public.jobs v
       where v.round = j.round and v.kind = 'view' and v.status = 'done'));
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
         usage = coalesce(info -> 'usage', '{}'::jsonb)
   where id = j.id;
  if j.kind = 'view' then
    perform public.release_rounds();
  end if;
  perform public.log_activity(j.table_id, j.member_id, 'ai.' || j.kind, msg, jsonb_build_object('job', j.id));
  return msg;
end;
$$;

-- A failed client job is not retried: the client is waiting, so their words go to the team at once.
create or replace function public.runner_fail(token text, job uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
begin
  select * into j from public.jobs where id = job for update;
  if not found or j.member_id <> c.member_id or j.status <> 'running' then
    raise exception 'this job is not yours';
  end if;
  if j.kind = 'client' then
    perform public.give_up_client_job(j.id, reason);
    return;
  end if;
  update public.jobs
     set status = case when j.attempts >= 3 then 'failed'::public.job_status else 'queued'::public.job_status end,
         error = left(coalesce(reason, ''), 500), lease_until = null
   where id = j.id;
end;
$$;

-- A client job nobody finished within 90 seconds goes to the team.
create function public.client_job_timeouts()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  stale uuid;
  n integer := 0;
begin
  for stale in
    select id from public.jobs
     where kind = 'client' and status in ('queued', 'running') and created_at < now() - interval '90 seconds'
  loop
    perform public.give_up_client_job(stale, 'no answer in 90 seconds');
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.client_job_timeouts() from public, anon, authenticated;
select cron.schedule('longtable-client-timeouts', '5 seconds', 'select public.client_job_timeouts()');

-- Live: client jobs and the client's chat with their AI go to that client's own channel, never the team's. A
-- client's connection coming and going reaches their page too.
create function public.broadcast_job_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'client' then
    perform realtime.broadcast_changes('client:' || new.table_id::text || ':' || new.member_id::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, null);
  else
    perform realtime.broadcast_changes('team:' || new.table_id::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
  end if;
  return null;
end;
$$;
drop trigger jobs_broadcast on public.jobs;
create trigger jobs_broadcast after insert or update on public.jobs
  for each row execute function public.broadcast_job_change();

create function public.broadcast_client_line()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.broadcast_changes('client:' || new.table_id::text || ':' || new.member_id::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, null);
  return null;
end;
$$;
create trigger client_lines_broadcast after insert or update on public.client_lines
  for each row execute function public.broadcast_client_line();

create or replace function public.broadcast_connection_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := jsonb_build_object('table', 'connections', 'record', to_jsonb(new) - 'token_hash');
begin
  perform realtime.send(rec, tg_op, 'team:' || new.table_id::text, true);
  if exists (select 1 from public.members m where m.id = new.member_id and m.role = 'client') then
    perform realtime.send(rec, tg_op, 'client:' || new.table_id::text || ':' || new.member_id::text, true);
  end if;
  return null;
end;
$$;
