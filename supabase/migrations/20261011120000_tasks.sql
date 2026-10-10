-- Tasks. Each piece of work the AIs take on is a task with a title and a branch of its own, so two people can have
-- their AIs working at the same time without touching each other's work, and a follow-up goes on with its task.
-- A task with several Claudes at the table starts with a plan: the asker's Claude says which part is its own and
-- which parts belong to someone else's Claude, each does its part at the same time, then everyone looks it over.
-- Work has no time limit: it is alive for as long as its connection says so.

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  chat_id uuid not null,
  member_id uuid references public.members (id) on delete set null,
  title text not null check (char_length(title) between 1 and 120),
  branch text not null,
  status text not null default 'working' check (status in ('working', 'done', 'stopped')),
  result text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index tasks_table_idx on public.tasks (table_id, created_at desc);
alter table public.tasks enable row level security;
revoke all on public.tasks from anon;
grant select on public.tasks to authenticated;
create policy "the team sees its tasks" on public.tasks for select to authenticated using (public.is_team(table_id));
create trigger tasks_broadcast after insert or update on public.tasks
  for each row execute function public.broadcast_team_change();

alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check
  check (kind in ('answer', 'view', 'combine', 'intro', 'client', 'work', 'review', 'listen', 'look', 'plan'));
alter table public.jobs add column task_id uuid references public.tasks (id) on delete set null;
alter table public.jobs add column brief text;

-- Clearing the list of work is each person's own: it hides what was finished before now, for them only.
alter table public.members add column tasks_cleared_at timestamptz;
create function public.clear_tasks(t uuid)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  at timestamptz := now();
begin
  if not public.is_team(t) then
    raise exception 'only the team has this list';
  end if;
  update public.members set tasks_cleared_at = at where id = public.my_member_id(t);
  return at;
end;
$$;
revoke all on function public.clear_tasks(uuid) from public, anon;
grant execute on function public.clear_tasks(uuid) to authenticated;

drop function public.start_round(uuid, uuid, uuid, uuid);
create function public.start_round(t uuid, c uuid, q uuid, me uuid, task uuid default null, title text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  seats uuid[];
  final uuid;
  offline text;
  online_seat uuid;
  r uuid := gen_random_uuid();
  s uuid;
  worker uuid;
  claudes integer;
  name text;
begin
  select array_agg(cn.member_id order by cn.created_at) into seats
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
   where cn.table_id = t and cn.revoked_at is null;
  if seats is null then
    return jsonb_build_object('message_id', q, 'answered_by', null);
  end if;

  if task is null then
    name := btrim(coalesce(nullif(btrim(title), ''), (select left(split_part(m.body, E'\n', 1), 70) from public.messages m where m.id = q), 'Work'));
    task := gen_random_uuid();
    insert into public.tasks (id, table_id, chat_id, member_id, title, branch)
      values (task, t, c, me, left(coalesce(nullif(name, ''), 'Work'), 120),
              'longtable/' || coalesce(nullif(btrim(left(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), 40), '-'), ''), 'work') || '-' || left(task::text, 4));
  else
    update public.tasks set status = 'working', finished_at = null where id = task;
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
    insert into public.jobs (table_id, chat_id, member_id, question_id, kind, task_id) values (t, c, final, q, 'answer', task);
    perform public.log_activity(t, me, 'table.asked', q, jsonb_build_object('answered_by', final, 'task', task));
    return jsonb_build_object('message_id', q, 'answered_by', final, 'task', task);
  end if;

  select cn.member_id into worker
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
   where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
   order by (cn.member_id = me) desc, cn.created_at limit 1;
  select count(distinct cn.member_id) into claudes
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
   where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds';
  if worker is not null then
    foreach s in array seats loop
      if s <> worker then
        insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, task_id) values (t, c, s, q, 'view', r, task);
      end if;
    end loop;
    -- With another Claude there to hand parts to, the work starts with a plan.
    insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, status, task_id)
      values (t, c, worker, q, case when claudes >= 2 then 'plan' else 'work' end, r, 'waiting', task);
    perform public.log_activity(t, me, 'table.asked', q, jsonb_build_object('answered_by', final, 'worker', worker, 'round', r, 'task', task));
    return jsonb_build_object('message_id', q, 'answered_by', final, 'worker', worker, 'round', r, 'task', task);
  end if;

  foreach s in array seats loop
    if s <> final then
      insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, task_id) values (t, c, s, q, 'view', r, task);
    end if;
  end loop;
  insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, status, task_id)
    values (t, c, final, q, 'combine', r, 'waiting', task);
  perform public.log_activity(t, me, 'table.asked', q, jsonb_build_object('answered_by', final, 'round', r, 'task', task));
  return jsonb_build_object('message_id', q, 'answered_by', final, 'round', r, 'task', task);
end;
$$;
revoke all on function public.start_round(uuid, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

create or replace function public.advance_round(r uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  g public.jobs;
  p public.jobs;
  w public.jobs;
  lead uuid;
  tk uuid;
  st integer;
  part jsonb;
  s uuid;
  workers integer;
  one uuid;
begin
  perform pg_advisory_xact_lock(hashtext(r::text));
  if exists (select 1 from public.jobs where round = r and kind = 'combine') then
    return;
  end if;
  select * into w from public.jobs where round = r and kind in ('plan', 'work') order by created_at, (kind = 'plan') desc limit 1;
  if not found then
    return;
  end if;
  lead := w.member_id;
  tk := w.task_id;

  -- The first step waits for the others to have their say.
  select * into g from public.jobs where round = r and status = 'waiting' and kind in ('plan', 'work') limit 1;
  if found then
    if not exists (select 1 from public.jobs v where v.round = r and v.kind = 'view' and v.status in ('queued', 'running'))
       or g.created_at < now() - interval '90 seconds' then
      update public.jobs set status = 'skipped', error = 'did not answer in time' where round = r and kind = 'view' and status = 'queued';
      update public.jobs set status = 'queued', created_at = now() where id = g.id;
    end if;
    return;
  end if;

  -- The plan, then one piece of work for each person it names.
  select * into p from public.jobs where round = r and kind = 'plan' limit 1;
  if found and not exists (select 1 from public.jobs where round = r and kind = 'work') then
    if p.status = 'queued' and p.created_at > now() - interval '5 minutes' then
      return;
    end if;
    if p.status = 'running' and p.lease_until > now() - interval '2 minutes' then
      return;
    end if;
    if p.status in ('queued', 'running') then
      update public.jobs set status = 'skipped', lease_until = null, error = 'the plan never came' where id = p.id;
      p.status := 'skipped';
    end if;
    if p.status = 'done' then
      for part in select * from jsonb_array_elements(coalesce(p.outcome -> 'parts', '[]'::jsonb)) loop
        insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, task_id, brief)
          values (p.table_id, p.chat_id, (part ->> 'member')::uuid, p.question_id, 'work', r, tk, part ->> 'brief');
      end loop;
    end if;
    if not exists (select 1 from public.jobs where round = r and kind = 'work') then
      insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, task_id)
        values (p.table_id, p.chat_id, lead, p.question_id, 'work', r, tk);
    end if;
    return;
  end if;

  select max(stage) into st from public.jobs where round = r and kind = 'work';
  if st is null then
    return;
  end if;
  -- Work has no time limit. It is only given up on when its computer never took it, or stopped saying it is alive.
  update public.jobs set status = 'skipped', lease_until = null,
         error = case when status = 'queued' then 'its computer never picked it up' else 'it stopped answering' end
   where round = r and kind = 'work' and stage = st
     and ((status = 'queued' and created_at < now() - interval '10 minutes'
           and not exists (select 1 from public.jobs b where b.member_id = jobs.member_id and b.id <> jobs.id and b.status = 'running' and b.kind in ('work', 'answer')))
       or (status = 'running' and lease_until < now() - interval '10 minutes'));
  if exists (select 1 from public.jobs where round = r and kind = 'work' and stage = st and status in ('queued', 'running')) then
    return;
  end if;

  if exists (select 1 from public.jobs where round = r and kind = 'work' and stage = st and status = 'done'
              and coalesce((outcome ->> 'changed')::boolean, false)) then
    if not exists (select 1 from public.jobs where round = r and kind = 'review' and stage = st) then
      if st < 2 then
        select count(distinct member_id), min(member_id::text)::uuid into workers, one
          from public.jobs where round = r and kind = 'work' and stage = st and status = 'done';
        -- One worker: the others look it over. Several: everyone looks over the whole of it, the others' parts included.
        for s in select distinct cn.member_id from public.connections cn
                  join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
                 where cn.table_id = w.table_id and cn.revoked_at is null
                   and cn.last_seen > now() - interval '60 seconds' and (workers > 1 or cn.member_id <> one) loop
          insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, stage, task_id)
            values (w.table_id, w.chat_id, s, w.question_id, 'review', r, st, tk);
        end loop;
        if exists (select 1 from public.jobs where round = r and kind = 'review' and stage = st) then
          return;
        end if;
      end if;
    else
      update public.jobs set status = 'skipped', error = 'did not answer in time', lease_until = null
        where round = r and kind = 'review' and stage = st
          and ((status = 'queued' and created_at < now() - interval '2 minutes'
                and not exists (select 1 from public.jobs b where b.member_id = jobs.member_id and b.id <> jobs.id and b.status = 'running' and b.kind not in ('work', 'answer')))
            or (status = 'running' and created_at < now() - interval '15 minutes'));
      if exists (select 1 from public.jobs where round = r and kind = 'review' and stage = st and status in ('queued', 'running')) then
        return;
      end if;
      if st < 2 and exists (select 1 from public.jobs where round = r and kind = 'review' and stage = st
                             and status = 'done' and not coalesce((outcome ->> 'ok')::boolean, true)) then
        insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, stage, task_id)
          values (w.table_id, w.chat_id, lead, w.question_id, 'work', r, st + 1, tk);
        return;
      end if;
    end if;
  end if;

  insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, task_id)
    values (w.table_id, w.chat_id, coalesce(public.final_seat_now(w.table_id), lead), w.question_id, 'combine', r, tk);
end;
$$;

-- A lone AI's work that failed for good closes its task.
create function public.close_failed_tasks()
returns void language sql security definer set search_path = '' as $$
  update public.tasks t set status = 'stopped', finished_at = now()
   where t.status = 'working' and t.created_at < now() - interval '1 minute'
     and not exists (select 1 from public.jobs j where j.task_id = t.id and j.status in ('queued', 'running', 'waiting'));
$$;
revoke all on function public.close_failed_tasks() from public, anon, authenticated;
select cron.schedule('longtable-close-tasks', '30 seconds', 'select public.close_failed_tasks()');

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
     limit 400
  ) x;

  if j.kind in ('combine', 'work', 'review', 'plan') then
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
    'brief', j.brief,
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
        mine := btrim(mine || E'\n' || (p ->> 'what'));
      elsif exists (select 1 from jsonb_array_elements(parts) e where e ->> 'member' = target::text) then
        parts := (select jsonb_agg(case when e ->> 'member' = target::text
                    then jsonb_set(e, '{brief}', to_jsonb((e ->> 'brief') || E'\n' || (p ->> 'what'))) else e end) from jsonb_array_elements(parts) e);
      else
        parts := parts || jsonb_build_object('member', target, 'brief', public.hide_secrets(left(p ->> 'what', 4000)));
      end if;
    end loop;
    if jsonb_array_length(parts) > 0 then
      parts := jsonb_build_object('member', j.member_id, 'brief', public.hide_secrets(left(nullif(btrim(mine), ''), 4000))) || parts;
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
  if j.task_id is not null and j.kind in ('answer', 'combine') then
    update public.tasks set status = 'done', finished_at = now(), result = left(info ->> 'read', 200) where id = j.task_id and status = 'working';
  end if;
  if j.round is not null then
    perform public.release_rounds();
    perform public.advance_round(j.round);
  end if;
  perform public.log_activity(j.table_id, j.member_id, 'ai.' || j.kind, msg, jsonb_build_object('job', j.id));
  return msg;
end;
$$;

create or replace function public.listen_now()
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
                 and j.kind in ('listen', 'look')) then
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

create or replace function public.stop_job(job uuid)
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
  update public.tasks set status = 'stopped', finished_at = now() where id = j.task_id and status = 'working';
  perform public.log_activity(j.table_id, me, 'ai.stopped', j.id, jsonb_build_object('kind', j.kind));
end;
$$;
