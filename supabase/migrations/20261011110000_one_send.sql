-- One Send button. People just talk; a listener decides whether the AIs are wanted and how much: nothing, a short
-- reply, a look at the code, or a full round of work. It is built to cost little: nothing at all for small talk
-- (a check in the database), one small request on the smallest model after the chat has been quiet a few seconds,
-- and the expensive round only when someone really asked for work.
-- Also: work that takes a long time. The connection sends a heartbeat with what it is doing, the work has its own
-- lane so quick jobs keep moving, and anyone on the team can stop it.

alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check
  check (kind in ('answer', 'view', 'combine', 'intro', 'client', 'work', 'review', 'listen', 'look'));
alter table public.jobs add column progress text;

create table public.listens (
  chat_id uuid primary key,
  table_id uuid not null references public.tables (id) on delete cascade,
  since timestamptz not null,
  due_at timestamptz not null
);
alter table public.listens enable row level security;
revoke all on public.listens from anon, authenticated;

-- Whose connection speaks for the table right now: the chosen one (or the owner's) when it is on, else the first on.
create function public.final_seat_now(t uuid)
returns uuid language sql security definer set search_path = '' stable as $$
  select cn.member_id
    from public.connections cn
    join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
    join public.tables tb on tb.id = cn.table_id
   where cn.table_id = t and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds'
   order by (cn.member_id = coalesce(tb.final_seat, (select o.id from public.members o where o.table_id = t and o.role = 'owner'))) desc, cn.created_at
   limit 1;
$$;
revoke all on function public.final_seat_now(uuid) from public, anon, authenticated;

-- Start the AIs on a message that is already in the chat. One AI: it does it. Several: a round.
create function public.start_round(t uuid, c uuid, q uuid, me uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  seats uuid[];
  final uuid;
  offline text;
  online_seat uuid;
  r uuid := gen_random_uuid();
  s uuid;
  worker uuid;
begin
  select array_agg(cn.member_id order by cn.created_at) into seats
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
   where cn.table_id = t and cn.revoked_at is null;
  if seats is null then
    return jsonb_build_object('message_id', q, 'answered_by', null);
  end if;
  select cn.member_id into online_seat
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
   where cn.table_id = t and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds'
   order by cn.created_at limit 1;

  select coalesce(tb.final_seat, (select m.id from public.members m where m.table_id = t and m.role = 'owner')), tb.when_final_offline
    into final, offline from public.tables tb where tb.id = t;
  if not (final = any (seats)) then
    final := coalesce(online_seat, seats[1]);
  elsif offline = 'next' and online_seat is not null and not exists (
      select 1 from public.connections cn where cn.member_id = final and cn.revoked_at is null
        and cn.last_seen > now() - interval '60 seconds') then
    final := online_seat;
  end if;

  if array_length(seats, 1) = 1 then
    insert into public.jobs (table_id, chat_id, member_id, question_id, kind) values (t, c, final, q, 'answer');
    perform public.log_activity(t, me, 'table.asked', q, jsonb_build_object('answered_by', final));
    return jsonb_build_object('message_id', q, 'answered_by', final);
  end if;

  select cn.member_id into worker
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
   where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
   order by (cn.member_id = me) desc, cn.created_at limit 1;
  if worker is not null then
    foreach s in array seats loop
      if s <> worker then
        insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round) values (t, c, s, q, 'view', r);
      end if;
    end loop;
    insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, status)
      values (t, c, worker, q, 'work', r, 'waiting');
    perform public.log_activity(t, me, 'table.asked', q, jsonb_build_object('answered_by', final, 'worker', worker, 'round', r));
    return jsonb_build_object('message_id', q, 'answered_by', final, 'worker', worker, 'round', r);
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
revoke all on function public.start_round(uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- Asking outright still works (Ctrl+Enter): the listener is skipped and the AIs start at once.
create or replace function public.ask_table(c uuid, body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t uuid;
  me uuid;
  q uuid;
begin
  select ch.table_id into t from public.chats ch where ch.id = c;
  if t is null or not public.is_team(t) then
    raise exception 'only the team can ask the table';
  end if;
  if char_length(btrim(coalesce(body, ''))) = 0 then
    raise exception 'ask something';
  end if;
  me := public.my_member_id(t);
  perform set_config('longtable.asked', '1', true);
  insert into public.messages (table_id, chat_id, member_id, body) values (t, c, me, btrim(body)) returning id into q;
  return public.start_round(t, c, q, me);
end;
$$;

-- Every message a person on the team writes is heard, a few seconds after the chat goes quiet.
create function public.hear_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.by_ai or new.kind <> 'chat' or coalesce(current_setting('longtable.asked', true), '') = '1' then
    return null;
  end if;
  if public.final_seat_now(new.table_id) is null then
    return null;
  end if;
  insert into public.listens (chat_id, table_id, since, due_at)
    values (new.chat_id, new.table_id, new.created_at, now() + interval '4 seconds')
    on conflict (chat_id) do update set due_at = excluded.due_at;
  return null;
end;
$$;
create trigger messages_heard after insert on public.messages
  for each row execute function public.hear_message();

-- The free check before any model is asked: is there anything here an AI could be wanted for? A question, a
-- request, an AI named, something long, or words said right after an AI spoke. Everything else costs nothing.
create function public.listen_now()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  l public.listens;
  worth boolean;
  latest uuid;
  seat uuid;
  n integer := 0;
begin
  update public.jobs set status = 'skipped', error = 'nobody picked it up'
   where kind in ('listen', 'look') and status = 'queued' and created_at < now() - interval '45 seconds';
  for l in select * from public.listens where due_at <= now() for update skip locked loop
    if exists (select 1 from public.jobs j where j.chat_id = l.chat_id and j.status in ('queued', 'running', 'waiting')
                 and j.kind not in ('client', 'intro')) then
      continue;
    end if;
    select exists (
        select 1 from public.messages m
         where m.chat_id = l.chat_id and m.kind = 'chat' and not m.by_ai and m.created_at >= l.since
           and (char_length(m.body) >= 80
                or m.body ~* '\?|@|\m(ai|ais|claude|chatgpt|gpt|codex|table|longtable)\M'
                or m.body ~* '^\s*(can|could|would|will|please|pls|make|add|fix|change|update|remove|delete|build|write|check|look|why|how|what|where|when|which|who|should|is|are|does|do|did|implement|create|refactor|rename|move|review|explain|tell|show|find|lets|let''s|go|try|use|set|put|run|test|ship|revert|undo|yes|yeah|yep|no|nah|ok|okay|sure)\M'))
      into worth;
    -- A bare yes or no only matters as an answer to an AI.
    if worth and not exists (
        select 1 from public.messages m
         where m.chat_id = l.chat_id and m.kind = 'chat' and not m.by_ai and m.created_at >= l.since
           and (char_length(m.body) >= 80 or m.body ~* '\?|@|\m(ai|ais|claude|chatgpt|gpt|codex|table|longtable)\M'
                or m.body !~* '^\s*(yes|yeah|yep|no|nah|ok|okay|sure|go)\M'))
       and not coalesce((select p.by_ai from public.messages p
                          where p.chat_id = l.chat_id and p.kind in ('chat', 'answer') and p.created_at < l.since
                            and p.created_at > l.since - interval '15 minutes'
                          order by p.created_at desc limit 1), false) then
      worth := false;
    end if;
    select m.id into latest from public.messages m
     where m.chat_id = l.chat_id and m.kind = 'chat' and not m.by_ai and m.created_at >= l.since
     order by m.created_at desc limit 1;
    delete from public.listens where chat_id = l.chat_id;
    seat := public.final_seat_now(l.table_id);
    if not worth or latest is null or seat is null then
      continue;
    end if;
    insert into public.jobs (table_id, chat_id, member_id, question_id, kind) values (l.table_id, l.chat_id, seat, latest, 'listen');
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.listen_now() from public, anon, authenticated;
select cron.schedule('longtable-listen', '2 seconds', 'select public.listen_now()');

-- A round, with work that may run for a long time. The work is alive as long as its connection keeps saying so; the
-- time limits are on waiting, never on working.
create or replace function public.advance_round(r uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  w public.jobs;
  final uuid;
  s uuid;
begin
  perform pg_advisory_xact_lock(hashtext(r::text));
  select * into w from public.jobs where round = r and kind = 'work' order by stage desc limit 1;
  if not found or exists (select 1 from public.jobs where round = r and kind = 'combine') then
    return;
  end if;

  if w.status = 'waiting' then
    if not exists (select 1 from public.jobs v where v.round = r and v.kind = 'view' and v.status in ('queued', 'running'))
       or w.created_at < now() - interval '90 seconds' then
      update public.jobs set status = 'skipped', error = 'did not answer in time' where round = r and kind = 'view' and status = 'queued';
      update public.jobs set status = 'queued', created_at = now() where id = w.id;
    end if;
    return;
  end if;
  if w.status = 'queued' and w.created_at > now() - interval '10 minutes' then
    return;
  end if;
  if w.status = 'running' and w.started_at > now() - interval '70 minutes' and w.lease_until > now() - interval '10 minutes' then
    return;
  end if;
  if w.status in ('queued', 'running') then
    update public.jobs set status = 'skipped', lease_until = null,
           error = case when w.status = 'queued' then 'its computer never picked it up' else 'it stopped answering' end
     where id = w.id;
    w.status := 'skipped';
  end if;

  if w.status = 'done' and coalesce((w.outcome ->> 'changed')::boolean, false) then
    if not exists (select 1 from public.jobs where round = r and kind = 'review' and stage = w.stage) then
      if w.stage < 2 then
        for s in select distinct cn.member_id from public.connections cn
                  join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
                 where cn.table_id = w.table_id and cn.revoked_at is null and cn.member_id <> w.member_id
                   and cn.last_seen > now() - interval '60 seconds' loop
          insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, stage)
            values (w.table_id, w.chat_id, s, w.question_id, 'review', r, w.stage);
        end loop;
        if exists (select 1 from public.jobs where round = r and kind = 'review' and stage = w.stage) then
          return;
        end if;
      end if;
    else
      update public.jobs set status = 'skipped', error = 'did not answer in time', lease_until = null
        where round = r and kind = 'review' and stage = w.stage
          and ((status = 'queued' and created_at < now() - interval '2 minutes')
            or (status = 'running' and created_at < now() - interval '12 minutes'));
      if exists (select 1 from public.jobs where round = r and kind = 'review' and stage = w.stage and status in ('queued', 'running')) then
        return;
      end if;
      if w.stage < 2 and exists (select 1 from public.jobs where round = r and kind = 'review' and stage = w.stage
                                  and status = 'done' and not coalesce((outcome ->> 'ok')::boolean, true)) then
        insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, stage)
          values (w.table_id, w.chat_id, w.member_id, w.question_id, 'work', r, w.stage + 1);
        return;
      end if;
    end if;
  end if;

  final := coalesce(public.final_seat_now(w.table_id), w.member_id);
  insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round)
    values (w.table_id, w.chat_id, final, w.question_id, 'combine', r);
end;
$$;

-- The connection says it is still working, and on what. False means stop: the job was stopped or taken away.
create function public.runner_beat(token text, job uuid, note text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
begin
  update public.jobs
     set lease_until = now() + interval '3 minutes', progress = nullif(left(public.hide_secrets(coalesce(note, '')), 120), '')
   where id = job and member_id = c.member_id and status = 'running';
  return found;
end;
$$;
revoke all on function public.runner_beat(text, uuid, text) from public, anon, authenticated;
grant execute on function public.runner_beat(text, uuid, text) to anon, authenticated;

-- Anyone on the team can stop what the AIs are doing in a chat. What was already pushed stays where it is.
create function public.stop_job(job uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  me uuid;
  who text;
begin
  select * into j from public.jobs where id = job for update;
  if not found or not public.is_team(j.table_id) or j.kind in ('client', 'intro') then
    raise exception 'that is not yours to stop';
  end if;
  me := public.my_member_id(j.table_id);
  select display_name into who from public.members where id = me;
  update public.jobs set status = 'skipped', lease_until = null, error = 'stopped by ' || who
   where status in ('queued', 'running', 'waiting') and (id = j.id or (j.round is not null and round = j.round));
  if j.round is not null and not exists (select 1 from public.jobs where round = j.round and kind = 'combine') then
    insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, status, error)
      values (j.table_id, j.chat_id, j.member_id, j.question_id, 'combine', j.round, 'skipped', 'stopped by ' || who);
  end if;
  perform public.log_activity(j.table_id, me, 'ai.stopped', j.id, jsonb_build_object('kind', j.kind));
end;
$$;
revoke all on function public.stop_job(uuid) from public, anon;
grant execute on function public.stop_job(uuid) to authenticated;

drop function public.runner_claim(text);

create function public.runner_claim(token text, lane text default null)
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
      and case lane when 'heavy' then kind in ('work', 'answer') when 'light' then kind not in ('work', 'answer')
               else kind in ('answer', 'view', 'combine', 'intro', 'client') end
    order by (kind in ('client', 'listen')) desc, (kind in ('combine', 'work', 'review')) desc, created_at
    limit 1
    for update skip locked;
  if not found then
    return null;
  end if;
  update public.jobs
     set status = 'running', attempts = attempts + 1, lease_until = now() + (case when j.kind = 'work' then interval '12 minutes' else interval '5 minutes' end),
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

  if j.kind in ('combine', 'work', 'review') then
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
    'stage', j.stage,
    'worker', (select mem.display_name from public.jobs w join public.members mem on mem.id = w.member_id where w.round = j.round and w.kind = 'work' limit 1),
    'work_read', (select m.meta ->> 'read' from public.jobs w join public.messages m on m.id = w.result_message_id
                   where w.round = j.round and w.kind = 'work' and w.status = 'done' and coalesce((w.outcome ->> 'changed')::boolean, false)
                   order by w.stage desc limit 1),
    'related', related,
    'pinned', pinned);
end;
$$;

revoke all on function public.runner_claim(text, text) from public, anon, authenticated;
grant execute on function public.runner_claim(text, text) to anon, authenticated;

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

  if j.kind = 'listen' then
    act := coalesce(info ->> 'act', 'silent');
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
      perform public.start_round(j.table_id, j.chat_id, q.id, q.member_id);
    end if;
    return msg;
  end if;

  if btrim(clean) = '' then
    raise exception 'an answer cannot be empty';
  end if;
  select display_name into who from public.members where id = j.member_id;
  kind_out := case when j.kind in ('view', 'work', 'review') then 'view' when j.kind = 'intro' then 'intro' else 'answer' end;
  meta := jsonb_build_object(
    'job', j.id, 'round', j.round, 'read', info ->> 'read', 'model', info ->> 'model',
    'sources', coalesce(info -> 'sources', '[]'::jsonb),
    'how', public.hide_secrets(coalesce(info ->> 'how', '')),
    'confidence', info ->> 'confidence',
    'part', j.kind, 'stage', j.stage, 'ok', info -> 'ok', 'changed', info -> 'changed',
    'hidden', clean <> left(coalesce(answer, ''), 8000));
  if j.kind = 'combine' then
    meta := meta || jsonb_build_object('parts', (
      select coalesce(jsonb_agg(distinct v.member_id), '[]'::jsonb) from public.jobs v
       where v.round = j.round and v.kind in ('view', 'work', 'review') and v.status = 'done' and v.member_id <> j.member_id));
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
         outcome = jsonb_build_object('changed', coalesce((info ->> 'changed')::boolean, false), 'ok', coalesce((info ->> 'ok')::boolean, true))
   where id = j.id;
  if j.round is not null then
    perform public.release_rounds();
    perform public.advance_round(j.round);
  end if;
  perform public.log_activity(j.table_id, j.member_id, 'ai.' || j.kind, msg, jsonb_build_object('job', j.id));
  return msg;
end;
$$;
