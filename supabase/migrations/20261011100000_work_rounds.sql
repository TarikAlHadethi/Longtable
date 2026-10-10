-- A round at a table with several AIs. One Claude does the work; the others say what they think before it starts and
-- look over what it did after; if one of them finds something, the worker goes again; then the table's own model
-- writes the one answer people read. The guard: at most two more goes after the first, and a round that is twenty
-- minutes old is closed with whatever there is.

alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in ('answer', 'view', 'combine', 'intro', 'client', 'work', 'review'));
alter table public.jobs add column stage integer not null default 0;
alter table public.jobs add column outcome jsonb not null default '{}'::jsonb;

-- Move one round on. Safe to call at any time and from anywhere: it looks at what is there and does the next thing.
create function public.advance_round(r uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  w public.jobs;
  final uuid;
  s uuid;
  old boolean;
begin
  perform pg_advisory_xact_lock(hashtext(r::text));
  select * into w from public.jobs where round = r and kind = 'work' order by stage desc limit 1;
  if not found or exists (select 1 from public.jobs where round = r and kind = 'combine') then
    return;
  end if;
  old := (select min(created_at) from public.jobs where round = r) < now() - interval '20 minutes';

  if w.status = 'waiting' then
    if not exists (select 1 from public.jobs v where v.round = r and v.kind = 'view' and v.status in ('queued', 'running'))
       or w.created_at < now() - interval '90 seconds' then
      update public.jobs set status = 'skipped', error = 'did not answer in time' where round = r and kind = 'view' and status = 'queued';
      update public.jobs set status = 'queued' where id = w.id;
    end if;
    return;
  end if;
  if w.status in ('queued', 'running') and not old then
    return;
  end if;
  if w.status in ('queued', 'running') then
    update public.jobs set status = 'skipped', error = 'the round ran out of time' where id = w.id;
    w.status := 'skipped';
  end if;

  if w.status = 'done' and coalesce((w.outcome ->> 'changed')::boolean, false) and not old then
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
      update public.jobs set status = 'skipped', error = 'did not answer in time'
        where round = r and kind = 'review' and stage = w.stage and status = 'queued' and created_at < now() - interval '2 minutes';
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

  -- Everything that was going to happen has: the table's own answer.
  select coalesce(tb.final_seat, (select m.id from public.members m where m.table_id = w.table_id and m.role = 'owner'))
    into final from public.tables tb where tb.id = w.table_id;
  if not exists (select 1 from public.connections cn where cn.member_id = final and cn.revoked_at is null
                  and cn.last_seen > now() - interval '60 seconds') then
    final := w.member_id;
  end if;
  insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round)
    values (w.table_id, w.chat_id, final, w.question_id, 'combine', r);
end;
$$;
revoke all on function public.advance_round(uuid) from public, anon, authenticated;

-- Every two seconds, alongside the old rounds: move on every round that is still open.
create function public.advance_rounds()
returns void language plpgsql security definer set search_path = '' as $$
declare
  r uuid;
begin
  for r in select distinct w.round from public.jobs w
            where w.kind = 'work' and w.created_at > now() - interval '2 hours'
              and not exists (select 1 from public.jobs c where c.round = w.round and c.kind = 'combine') loop
    perform public.advance_round(r);
  end loop;
end;
$$;
revoke all on function public.advance_rounds() from public, anon, authenticated;
select cron.schedule('longtable-advance-rounds', '2 seconds', 'select public.advance_rounds()');

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
  worker uuid;
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

  -- Who does the work: the asker's own Claude when it is on, else the first Claude that is on.
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
    order by (kind = 'client') desc, (kind in ('combine', 'work', 'review')) desc, created_at
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
  if j.round is not null then
    perform public.advance_round(j.round);
  end if;
end;
$$;
