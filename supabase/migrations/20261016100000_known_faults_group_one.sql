-- Known faults the bug sweep and the chaos run reported and left open, fixed together (group 1 of 16 Oct 2026).
--
-- D11, one owner per table. Two hand-overs at once each locked only the person they were handing to, so both went
-- through and the table had two owners; a hand-over racing the removal of the same person left the owner removed.
-- After either, every chat message failed. Hand-overs and removals now take the table's own row first, so they go
-- one at a time, and each reads the person again after taking it. A unique index then holds one owner per table, but
-- only where the live data already has one each: if any table has two, the index is left out and a notice says so,
-- rather than stopping this whole migration.
--
-- D10, a round's lead taken off. A round kept handing its next step (the work after a plan, the second go after a
-- review, the table's answer when nobody else was on) to its lead after the lead was taken off the table. Their AI is
-- disconnected, so nothing ever took it and the round sat for ten minutes. Now the next step goes to a person who is
-- still at the table with an AI connected, and parts of a plan meant for someone taken off go to the lead.
--
-- A lead plan or work job still "waiting" in a round that already has its table's answer was never closed while its
-- person's computer stayed on, and kept its task "working". A waiting job is running nothing, so it is closed at once.
--
-- D8, what a connection sends and the table keeps. runner_finish stored the files read, the model, the sources, the
-- confidence and the usage as sent, and runner_leave its reason; a key or a sign-in in any of them was kept as it
-- was. Each now goes through hide_secrets and a length cut, usage keeps numbers only, and a sandbox change's file
-- names are hidden the same way.

-- A person still at a table, with an AI of theirs connected there.
create or replace function public.seat_alive(m uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members mb join public.connections cn on cn.member_id = mb.id
                  where mb.id = m and mb.removed_at is null and cn.revoked_at is null);
$$;
revoke all on function public.seat_alive(uuid) from public, anon, authenticated;

-- One short line from a connection, made safe to keep: secrets hidden, cut, nothing for nothing.
-- hide_secrets knows key shapes; a sign-in written into an address (a name and a password before the host) is taken
-- out here as well.
create or replace function public.kept_line(v text, n integer)
returns text language sql stable set search_path = '' as $$
  select nullif(public.hide_secrets(left(regexp_replace(btrim(coalesce(v, '')), '//[^/[:space:]:@]+:[^/[:space:]@]+@', '//[hidden]@', 'g'), n)), '');
$$;
revoke all on function public.kept_line(text, integer) from public, anon, authenticated;

-- A job's usage as numbers only: tokens, steps, times. Anything else a connection put there is dropped.
create or replace function public.kept_usage(u jsonb)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce((select jsonb_object_agg(left(k, 40), v) from jsonb_each(case when jsonb_typeof(u) = 'object' then u else '{}'::jsonb end) e(k, v)
                    where jsonb_typeof(v) = 'number'), '{}'::jsonb);
$$;
revoke all on function public.kept_usage(jsonb) from public, anon, authenticated;

-- A list of short lines from a connection (sources, file names): strings only, each made safe, at most n of them.
create or replace function public.kept_list(a jsonb, n integer)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce((select jsonb_agg(public.kept_line(x, 300)) from (
    select e #>> '{}' x from jsonb_array_elements(case when jsonb_typeof(a) = 'array' then a else '[]'::jsonb end) e
     where jsonb_typeof(e) = 'string' limit n) s
   where public.kept_line(x, 300) is not null), '[]'::jsonb);
$$;
revoke all on function public.kept_list(jsonb, integer) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.transfer_ownership(m uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  who public.members;
  me uuid;
begin
  select * into who from public.members where id = m;
  if not found then
    raise exception 'only the owner can hand the table over';
  end if;
  -- One hand-over or removal at a table at a time, and the person read again once it is this one's turn.
  perform 1 from public.tables where id = who.table_id for update;
  select * into who from public.members where id = m for update;
  if not public.is_owner(who.table_id) then
    raise exception 'only the owner can hand the table over';
  end if;
  me := public.my_member_id(who.table_id);
  if who.id = me then
    raise exception 'you already own this table';
  end if;
  if who.removed_at is not null or who.role <> 'developer' then
    raise exception 'the table can only be handed to a developer who is at it';
  end if;
  update public.members set role = 'developer' where id = me;
  update public.members set role = 'owner' where id = who.id;
  perform public.log_activity(who.table_id, me, 'table.handed_over', who.id, jsonb_build_object('name', who.display_name));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.remove_member(m uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  who public.members;
begin
  select * into who from public.members where id = m;
  if not found then
    raise exception 'only the owner takes people off the table';
  end if;
  -- One hand-over or removal at a table at a time, and the person read again once it is this one's turn: a
  -- hand-over to them that went first has made them the owner, who cannot be taken off.
  perform 1 from public.tables where id = who.table_id for update;
  select * into who from public.members where id = m for update;
  if not public.is_owner(who.table_id) then
    raise exception 'only the owner takes people off the table';
  end if;
  if who.role = 'owner' then
    raise exception 'the owner cannot be taken off';
  end if;
  if who.removed_at is not null then
    return;
  end if;
  update public.members set removed_at = now() where id = m;
  update public.connections set revoked_at = now() where member_id = m and revoked_at is null;
  -- A connect code they made and have not used yet connects nothing now.
  update public.pairings set used_at = now() where member_id = m and used_at is null;
  -- A client's question their AI was answering for the team is passed on to the team, not dropped with them.
  if who.role <> 'client' then
    perform public.give_up_client_job(j.id, 'taken off the table')
       from public.jobs j where j.member_id = m and j.kind = 'client' and j.status in ('queued', 'running');
  end if;
  update public.jobs set status = 'skipped', lease_until = null, error = 'taken off the table'
   where member_id = m and status in ('queued', 'running', 'waiting');
  -- A client taken off is not answered any more either: a question of theirs a team AI is answering, and work on
  -- their copy, stop with them, or the answer still landed in their chat and passed a request on in their name.
  update public.jobs set status = 'skipped', lease_until = null, error = 'taken off the table'
   where subject = m and status in ('queued', 'running', 'waiting');
  update public.tables set final_seat = null where id = who.table_id and final_seat = m;
  if who.role = 'client' then
    perform realtime.send(jsonb_build_object('table', 'members', 'record', jsonb_build_object('id', m, 'removed_at', now())),
      'UPDATE', 'client:' || who.table_id::text || ':' || m::text, true);
  end if;
  perform public.log_activity(who.table_id, public.my_member_id(who.table_id), 'member.removed', m,
    jsonb_build_object('name', who.display_name, 'role', who.role));
end;
$function$
;

-- One owner per table, as a rule the database keeps. Only made where no table already breaks it.
do $$
begin
  if exists (select 1 from public.members where role = 'owner' group by table_id having count(*) > 1) then
    raise notice 'members_one_owner not made: a table has more than one owner. Settle it by hand, then make the index.';
  else
    create unique index if not exists members_one_owner on public.members (table_id) where role = 'owner';
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION public.advance_round(r uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- A lead taken off the table, or whose AI is gone, hands the rest of the round on to someone still here.
  if not public.seat_alive(lead) then
    lead := coalesce(public.final_seat_now(w.table_id), lead);
  end if;

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
    if p.status = 'failed' and not exists (select 1 from public.connections cn where cn.member_id = lead and cn.revoked_at is null) then
      insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, task_id)
        values (p.table_id, p.chat_id, coalesce(public.final_seat_now(p.table_id), lead), p.question_id, 'combine', r, tk);
      return;
    end if;
    if p.status = 'done' then
      for part in select * from jsonb_array_elements(coalesce(p.outcome -> 'parts', '[]'::jsonb)) loop
        insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, task_id, brief)
          values (p.table_id, p.chat_id,
                  case when public.seat_alive((part ->> 'member')::uuid) then (part ->> 'member')::uuid else lead end,
                  p.question_id, 'work', r, tk, part ->> 'brief');
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
           and not exists (select 1 from public.jobs b where b.member_id = jobs.member_id and b.id <> jobs.id and b.status = 'running' and b.kind in ('work', 'answer') and b.lease_until > now()))
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
                and not exists (select 1 from public.jobs b where b.member_id = jobs.member_id and b.id <> jobs.id and b.status = 'running' and b.kind not in ('work', 'answer') and b.lease_until > now()))
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
$function$
;

CREATE OR REPLACE FUNCTION public.close_failed_tasks()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.jobs set status = 'skipped', lease_until = null, error = 'its computer never picked it up'
   where kind in ('combine', 'answer') and task_id is not null
     and ((status = 'running' and lease_until < now() - interval '10 minutes')
       or (status = 'queued' and created_at < now() - interval '10 minutes'
           and not exists (select 1 from public.connections cn where cn.member_id = jobs.member_id
                            and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds')));
  -- A round whose table's answer is finished, given up on or failed has nothing left to wait for: what it still has
  -- open (a view nobody took) is closed with it, or it stayed queued for ever and kept its task "working". A step
  -- still waiting its turn is running nothing, so it goes at once; anything else only by the same rule as above: its
  -- lease long run out, or never taken while its computer is gone. A slow view whose AI is still at it is left.
  update public.jobs j set status = 'skipped', lease_until = null, error = 'the round was already over'
   where j.round is not null and j.status in ('queued', 'running', 'waiting') and j.kind <> 'combine'
     and exists (select 1 from public.jobs c where c.round = j.round and c.kind = 'combine' and c.status in ('done', 'failed', 'skipped'))
     and (j.status = 'waiting'
       or (j.status = 'running' and j.lease_until < now() - interval '10 minutes')
       or (j.status = 'queued' and j.created_at < now() - interval '10 minutes'
           and not exists (select 1 from public.connections cn where cn.member_id = j.member_id
                            and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds')));
  -- An introduction whose computer never took it, or stopped answering, is given up on the same way.
  update public.jobs set status = 'skipped', lease_until = null, error = 'its computer never picked it up'
   where kind = 'intro'
     and ((status = 'running' and lease_until < now() - interval '10 minutes')
       or (status = 'queued' and created_at < now() - interval '10 minutes'
           and not exists (select 1 from public.connections cn where cn.member_id = jobs.member_id
                            and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds')));
  update public.tasks t set status = 'stopped', finished_at = now()
   where t.status = 'working' and t.created_at < now() - interval '1 minute'
     and not exists (select 1 from public.jobs j where j.task_id = t.id and j.status in ('queued', 'running', 'waiting'))
     and not exists (select 1 from public.jobs w where w.task_id = t.id and w.round is not null and w.kind in ('plan', 'work')
                      and not exists (select 1 from public.jobs c where c.round = w.round and c.kind = 'combine'));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.runner_finish(token text, job uuid, answer text, info jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      req := public.pass_on_request(coalesce(j.subject, j.member_id), line.body, public.hide_secrets(left(coalesce(info ->> 'title', ''), 120)), line.id, false);
    end if;
    insert into public.client_lines (table_id, member_id, who, body, request_id, by_table)
      values (j.table_id, coalesce(j.subject, j.member_id), 'assistant',
              coalesce(nullif(btrim(left(clean, 4000)), ''), 'Passed on to the team. You will hear here what they decide.'), req, j.subject is not null)
      returning id into msg;
    update public.jobs
       set status = 'done', finished_at = now(), lease_until = null, usage = public.kept_usage(info -> 'usage')
     where id = j.id;
    return msg;
  end if;

  -- A change in a client's sandbox. What the client reads is the plain summary; the files and the rest are the team's.
  if j.kind = 'sandbox' and j.change_id is null then
    update public.sandboxes
       set opened_at = now(), tip = case when coalesce(info ->> 'commit', '') ~ '^[0-9a-f]{7,40}$' then info ->> 'commit' else tip end
     where member_id = j.subject;
    update public.jobs set status = 'done', finished_at = now(), lease_until = null where id = j.id;
    return null;
  end if;
  if j.kind = 'sandbox' then
    select * into ch from public.sandbox_changes where id = j.change_id for update;
    if coalesce((info ->> 'pass_on')::boolean, false) and ch.test then
      update public.sandbox_changes set status = 'nothing', finished_at = now(), summary = left(clean, 1200),
             detail = public.hide_secrets(left(coalesce(info ->> 'detail', ''), 4000)) where id = ch.id;
    elsif coalesce((info ->> 'pass_on')::boolean, false) then
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
             files = public.kept_list(info -> 'files', 80),
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
       set status = 'done', finished_at = now(), lease_until = null, usage = public.kept_usage(info -> 'usage')
     where id = j.id;
    return null;
  end if;

  if j.kind = 'listen' then
    act := case when info ->> 'act' in ('reply', 'look', 'work') then info ->> 'act' else 'silent' end;
    update public.jobs
       set status = 'done', finished_at = now(), lease_until = null, usage = public.kept_usage(info -> 'usage'),
           outcome = jsonb_build_object('act', act)
     where id = j.id;
    select * into q from public.messages where id = j.question_id;
    if act = 'reply' and btrim(clean) <> '' then
      insert into public.messages (table_id, chat_id, member_id, body, by_ai, kind, meta)
        values (j.table_id, j.chat_id, j.member_id, left(clean, 1500), true, 'answer',
                jsonb_build_object('job', j.id, 'model', public.kept_line(info ->> 'model', 80), 'sources', '[]'::jsonb, 'part', 'reply'))
        returning id into msg;
      update public.jobs set result_message_id = msg where id = j.id;
    elsif act = 'look' then
      -- A look is done by the Claude of whoever asked, when it is on: it is the one that knows what they know. Else by
      -- the table's seat.
      insert into public.jobs (table_id, chat_id, member_id, question_id, kind)
        values (j.table_id, j.chat_id,
                coalesce((select cn.member_id from public.connections cn
                           where cn.member_id = q.member_id and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds' limit 1), j.member_id),
                j.question_id, 'look');
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
    'job', j.id, 'round', j.round, 'read', public.kept_line(info ->> 'read', 300), 'model', public.kept_line(info ->> 'model', 80),
    'sources', public.kept_list(info -> 'sources', 40),
    'how', public.hide_secrets(left(coalesce(info ->> 'how', ''), 4000)),
    'confidence', public.kept_line(info ->> 'confidence', 40),
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
      values (j.table_id, j.member_id, 'intro', who || '''s Claude', left(clean, 4000))
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
         usage = public.kept_usage(info -> 'usage'),
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
$function$
;

CREATE OR REPLACE FUNCTION public.runner_leave(token text, reason text DEFAULT ''::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.connections := public.connection_for(token);
begin
  update public.connections set revoked_at = now() where id = c.id and revoked_at is null;
  update public.jobs set status = 'failed', lease_until = null, finished_at = now(), error = coalesce(public.kept_line(reason, 300), 'the connection did not finish setting up')
   where member_id = c.member_id and kind = 'intro' and status in ('queued', 'running');
  perform public.log_activity(c.table_id, c.member_id, 'connection.removed', c.id, jsonb_build_object('kind', c.kind, 'setup_failed', true));
end;
$function$
;
