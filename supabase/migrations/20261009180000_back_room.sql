-- Step 4: several AIs at one table. Each connected AI gives its view in the back room, and the final-answer AI
-- writes one combined answer with how they got there and what they read. Plus intro cards, the pinned project
-- summary, and search over the table's own history for the AIs to draw on.

-- Who writes the final answer: the table's choice, or its owner. When that AI is offline: wait, or let the next one.
alter table public.tables add column final_seat uuid references public.members (id) on delete set null;
alter table public.tables add column when_final_offline text not null default 'wait'
  check (when_final_offline in ('wait', 'next'));

alter table public.jobs add column kind text not null default 'answer'
  check (kind in ('answer', 'view', 'combine', 'intro'));
alter table public.jobs add column round uuid;
create index jobs_round_idx on public.jobs (round) where round is not null;

-- Message kinds: people write chat; AIs write answers, back-room views and intro cards.
alter table public.messages add column kind text not null default 'chat'
  check (kind in ('chat', 'answer', 'view', 'intro'));
update public.messages set kind = 'answer' where by_ai;
drop policy "the team writes messages as itself" on public.messages;
create policy "the team writes messages as itself" on public.messages
  for insert to authenticated
  with check (public.is_team(table_id) and member_id = public.my_member_id(table_id)
              and not by_ai and kind = 'chat' and meta = '{}'::jsonb);

-- Pinned notes: each AI's intro card, the project summary, and later notes people share.
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  member_id uuid references public.members (id) on delete set null,
  kind text not null check (kind in ('intro', 'summary', 'shared')),
  title text not null default '' check (char_length(title) <= 120),
  body text not null check (char_length(body) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index notes_one_intro_per_seat on public.notes (table_id, member_id) where kind = 'intro';
create unique index notes_one_summary on public.notes (table_id) where kind = 'summary';
alter table public.notes enable row level security;
revoke all on public.notes from anon;
create policy "the team reads its notes" on public.notes for select to authenticated using (public.is_team(table_id));
create trigger notes_broadcast after insert or update on public.notes
  for each row execute function public.broadcast_team_change();

-- Search over the table's own history and notes. Plain Postgres full-text search: no embedding model, no key.
alter table public.messages add column search tsvector generated always as (to_tsvector('english', body)) stored;
create index messages_search_idx on public.messages using gin (search);
alter table public.notes add column search tsvector generated always as (to_tsvector('english', title || ' ' || body)) stored;
create index notes_search_idx on public.notes using gin (search);

-- A round is ready for its final answer once every view is in, or after 90 seconds with whatever came in.
create function public.release_rounds()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  w public.jobs;
  n integer := 0;
begin
  for w in select * from public.jobs where kind = 'combine' and status = 'waiting' for update skip locked loop
    if not exists (select 1 from public.jobs v where v.round = w.round and v.kind = 'view' and v.status in ('queued', 'running'))
       or w.created_at < now() - interval '90 seconds' then
      update public.jobs set status = 'skipped', error = 'did not answer in time'
        where round = w.round and kind = 'view' and status = 'queued';
      update public.jobs set status = 'queued' where id = w.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
revoke all on function public.release_rounds() from public, anon, authenticated;
select cron.schedule('longtable-release-rounds', '2 seconds', 'select public.release_rounds()');

-- Ask the table. One AI connected: it answers. Several: each gives a view, the final-answer AI combines them.
-- The final-answer AI is the table's choice, or the owner's. If that person never connected an AI, the first
-- connected one writes instead. If they did but their computer is off: wait for it (default), or let one that is on.
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
    from public.connections cn where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude';
  if seats is null then
    return jsonb_build_object('message_id', q, 'answered_by', null);
  end if;
  select cn.member_id into online_seat from public.connections cn
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

-- Turn a question into a loose search: any of its words, stemmed, so related history is found even when it is
-- worded differently. Each word is quoted, so nothing in a question can change the shape of the search.
create function public.loose_query(question text)
returns tsquery language sql immutable set search_path = '' as $$
  select case when cardinality(lex) = 0 then null
              else to_tsquery('simple', array_to_string(array(
                     select quote_literal(l) from unnest(lex) l), ' | ')) end
  from (select tsvector_to_array(to_tsvector('english', coalesce(question, ''))) as lex) x;
$$;

-- Pairing now also asks the new AI to introduce itself: what it knows, what it can check.
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
  if p.kind = 'claude' then
    insert into public.jobs (table_id, chat_id, member_id, kind) values (p.table_id, general, p.member_id, 'intro');
  end if;
  perform public.log_activity(p.table_id, p.member_id, 'connection.paired', conn, jsonb_build_object('kind', p.kind, 'name', who.display_name));
  return jsonb_build_object('token', token, 'table_id', p.table_id, 'table_name', tname,
    'member_id', p.member_id, 'member_name', who.display_name, 'kind', p.kind);
end;
$$;

-- The runner takes the next job. It now gets the kind of job, the back-room views for a combine, the pinned notes,
-- and the most relevant earlier messages from anywhere at the table.
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
    order by (kind = 'combine') desc, created_at
    limit 1
    for update skip locked;
  if not found then
    return null;
  end if;
  update public.jobs
     set status = 'running', attempts = attempts + 1, lease_until = now() + interval '5 minutes',
         connection_id = c.id, started_at = now()
   where id = j.id;
  select * into q from public.messages where id = j.question_id;

  select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb) into history from (
    select m.created_at, m.body, m.by_ai, mem.display_name as name
      from public.messages m join public.members mem on mem.id = m.member_id
     where m.chat_id = j.chat_id and m.kind in ('chat', 'answer')
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
      select ch.name as chat, mem.display_name as name, m.by_ai, m.body,
             ts_rank(m.search, public.loose_query(q.body)) as rank
        from public.messages m
        join public.members mem on mem.id = m.member_id
        join public.chats ch on ch.id = m.chat_id
       where m.table_id = j.table_id and m.kind in ('chat', 'answer') and m.id <> q.id
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

-- The runner posts its work. info carries the structured result: for an answer or a combine, sources and how they
-- got there; for a view, its sources and confidence; for an intro, what the AI knows and can check, and a summary.
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
begin
  select * into j from public.jobs where id = job for update;
  if not found or j.member_id <> c.member_id or j.status <> 'running' then
    raise exception 'this job is not yours to finish';
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

-- Settings for the final answer: only the owner changes them.
create function public.set_final_seat(t uuid, seat uuid, offline text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_owner(t) then
    raise exception 'only the owner changes who writes the final answer';
  end if;
  if seat is not null and not exists (select 1 from public.members where id = seat and table_id = t and role in ('owner', 'developer')) then
    raise exception 'the final answer has to come from someone on the team';
  end if;
  if offline not in ('wait', 'next') then
    raise exception 'unknown choice';
  end if;
  update public.tables set final_seat = seat, when_final_offline = offline where id = t;
  perform public.log_activity(t, public.my_member_id(t), 'settings.final_seat', seat, jsonb_build_object('offline', offline));
end;
$$;
revoke all on function public.set_final_seat(uuid, uuid, text) from public, anon;
grant execute on function public.set_final_seat(uuid, uuid, text) to authenticated;
