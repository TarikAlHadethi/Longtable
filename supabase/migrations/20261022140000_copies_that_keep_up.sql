-- A client's copy that keeps up with them:
-- * "Try it" waits for the hosting. The copy remembers the newest commit pushed to it (tip) and, from the hosting's own
--   deployment events, the newest one put online (live_sha) or that failed to build (failed_sha). While the tip is not
--   online yet the client reads "Building your copy"; a failed build is said to the client in plain words and to the
--   team in General. A table whose hosting never reports deployments behaves as before.
-- * A change can be taken back: the client's "Undo this" on their newest change, and the team's "Not this", take that
--   one commit back out of the copy (undone: undoing, undone, or stuck when it could not come out cleanly).
-- * The copy keeps up with the team: opening the page brings it up to what the team has shipped (at most hourly),
--   keeping the client's changes on top.
-- * A review that is still working is never dropped for taking long (it was dropped 15 minutes after it started); only
--   one whose computer stopped answering is. Rounds themselves have no time limit.

alter table public.sandboxes add column if not exists live_sha text, add column if not exists failed_sha text,
  add column if not exists deploys_seen boolean not null default false, add column if not exists tip_at timestamptz,
  add column if not exists refreshed_at timestamptz;
alter table public.sandbox_changes add column if not exists undone text check (undone in ('undoing', 'undone', 'stuck'));

-- The same commit, whether either side was written short or whole.
create or replace function public.same_commit(a text, b text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(char_length(a) >= 7 and char_length(b) >= 7 and (starts_with(a, b) or starts_with(b, a)), false);
$$;

-- The team's Claude that keeps a client's copy: the table's own seat when it is a Claude that is on, else the first on.
create or replace function public.copy_seat(t uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select cn.member_id
    from public.connections cn join public.members mem on mem.id = cn.member_id and mem.role in ('owner', 'developer') and mem.removed_at is null
   where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
   order by (cn.member_id = public.final_seat_now(t)) desc, cn.created_at limit 1;
$$;
revoke all on function public.copy_seat(uuid) from public, anon, authenticated;

-- Take one change back out of a copy (the newest one still in it when none is named). Returns the change.
create or replace function public.undo_in_copy(ch public.sandbox_changes)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  seat uuid := public.copy_seat(ch.table_id);
begin
  if seat is null or ch.commit is null or ch.status <> 'ready' or ch.undone is not null or ch.test then
    return false;
  end if;
  update public.sandbox_changes set undone = 'undoing' where id = ch.id;
  insert into public.jobs (table_id, member_id, kind, subject, change_id, brief) values (ch.table_id, seat, 'sandbox', ch.member_id, ch.id, 'undo');
  return true;
end;
$$;
revoke all on function public.undo_in_copy(public.sandbox_changes) from public, anon, authenticated;

create or replace function public.client_undo_change(t uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me public.members;
  ch public.sandbox_changes;
begin
  select * into me from public.members where id = public.client_seat(t);
  if not found or me.role <> 'client' or me.removed_at is not null then
    raise exception 'only the client changes their copy';
  end if;
  if exists (select 1 from public.sandbox_changes x where x.member_id = me.id and x.undone = 'undoing') then
    raise exception 'one is already being taken back';
  end if;
  select * into ch from public.sandbox_changes x
   where x.member_id = me.id and x.status = 'ready' and x.undone is null and not x.test and x.commit is not null
   order by x.created_at desc limit 1 for update;
  if not found then
    raise exception 'there is nothing to take back';
  end if;
  if not public.undo_in_copy(ch) then
    raise exception 'the team''s computers are off right now, so it cannot be taken back yet; try again in a while';
  end if;
  perform public.log_activity(t, me.id, 'sandbox.undo', ch.id, '{}'::jsonb);
  return ch.id;
end;
$$;
revoke all on function public.client_undo_change(uuid) from public, anon;
grant execute on function public.client_undo_change(uuid) to authenticated;

-- Opening the copy brings it up to the team's latest, at most once an hour, on the team's Claude when one is on.
create or replace function public.client_refresh_copy(t uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  me public.members;
  sb public.sandboxes;
  seat uuid;
begin
  select * into me from public.members where id = public.client_seat(t);
  if not found or me.role <> 'client' or me.removed_at is not null then
    return false;
  end if;
  select * into sb from public.sandboxes where member_id = me.id for update;
  if not found or sb.mode <> 'sandbox' or sb.refreshed_at > now() - interval '1 hour'
     or exists (select 1 from public.jobs j where j.subject = me.id and j.kind = 'sandbox' and j.status in ('queued', 'running')) then
    return false;
  end if;
  seat := public.copy_seat(t);
  if seat is null then
    return false;
  end if;
  update public.sandboxes set refreshed_at = now() where member_id = me.id;
  insert into public.jobs (table_id, member_id, kind, subject, brief) values (t, seat, 'sandbox', me.id, 'refresh');
  return true;
end;
$$;
revoke all on function public.client_refresh_copy(uuid) from public, anon;
grant execute on function public.client_refresh_copy(uuid) to authenticated;

-- Reviews: one still working is never dropped for taking long; only one whose computer stopped answering (advance_round below).

CREATE OR REPLACE FUNCTION public.sandbox_job_payload(j jobs)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ch public.sandbox_changes;
  who public.members;
begin
  if j.change_id is null then
    -- Only the place is being made: the branch, pushed as it stands, so the hosting puts it up.
    return jsonb_build_object('job_id', j.id, 'kind', 'sandbox', 'probe', true, 'fresh', coalesce(j.brief = 'fresh', false),
      'refresh', coalesce(j.brief = 'refresh', false),
      'table_name', (select name from public.tables where id = j.table_id),
      'me', (select display_name from public.members where id = j.member_id),
      'branch', (select s.branch from public.sandboxes s where s.member_id = j.subject));
  end if;
  select * into ch from public.sandbox_changes where id = j.change_id;
  select * into who from public.members where id = ch.member_id;
  if j.brief = 'undo' then
    -- Taking one change back out: its commit, and the words it was for (for the commit's message). Marked a probe
    -- too, so a connection from before undo existed only looks at the branch and changes nothing.
    return jsonb_build_object('job_id', j.id, 'kind', 'sandbox', 'undo', true, 'probe', true, 'commit', ch.commit, 'words', ch.words,
      'me', (select display_name from public.members where id = j.member_id),
      'branch', (select s.branch from public.sandboxes s where s.member_id = ch.member_id));
  end if;
  return jsonb_build_object(
    'job_id', j.id,
    'kind', 'sandbox',
    'table_name', (select name from public.tables where id = j.table_id),
    'me', (select display_name from public.members where id = j.member_id),
    'client', who.display_name,
    'words', ch.words,
    'test', ch.test,
    'branch', (select s.branch from public.sandboxes s where s.member_id = ch.member_id),
    'paths', coalesce((select ts.paths from public.table_sandbox ts where ts.table_id = j.table_id), ''),
    'earlier', (select coalesce(jsonb_agg(jsonb_build_object('words', left(c.words, 600), 'summary', left(coalesce(c.summary, ''), 400), 'status', c.status,
                  'verdict', c.verdict, 'note', c.note) order by c.created_at), '[]'::jsonb)
                  from (select * from public.sandbox_changes x where x.member_id = ch.member_id and x.id <> ch.id and x.status <> 'working'
                         order by x.created_at desc limit 12) c));
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
  looker uuid;
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
  matches integer;
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
    -- The team's assistant could not answer from what it has: a team Claude that can read the code answers the
    -- question it wrote, in its own words (stage 1). The client's own words never reach that AI.
    if j.subject is not null and coalesce(j.stage, 0) = 0 and coalesce((info ->> 'look')::boolean, false)
       and btrim(coalesce(info ->> 'ask', '')) <> '' then
      looker := public.client_look_seat(j.table_id);
      if looker is not null then
        update public.jobs set status = 'done', finished_at = now(), lease_until = null, usage = public.kept_usage(info -> 'usage') where id = j.id;
        insert into public.jobs (table_id, member_id, kind, line_id, subject, stage, brief)
          values (j.table_id, looker, 'client', j.line_id, j.subject, 1, public.hide_secrets(left(btrim(info ->> 'ask'), 2000)));
        return null;
      end if;
    end if;
    passing := coalesce((info ->> 'pass_on')::boolean, true) or btrim(clean) = '';
    select * into line from public.client_lines where id = j.line_id;
    -- Words that already reached the team (nobody's AI was on when they were said) are never passed on twice.
    if line.request_id is not null then
      passing := false;
    end if;
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
  -- A copy's newest commit, whenever one is pushed (made, caught up, a change, one taken back): "Try it" waits until the
  -- hosting has that one online. Unchanged, nothing is waited for.
  if j.kind = 'sandbox' and coalesce(info ->> 'commit', '') ~ '^[0-9a-f]{7,40}$' then
    update public.sandboxes
       set tip_at = case when public.same_commit(tip, info ->> 'commit') then tip_at else now() end,
           tip = info ->> 'commit'
     where member_id = j.subject or member_id = (select sc.member_id from public.sandbox_changes sc where sc.id = j.change_id);
  end if;
  if j.kind = 'sandbox' and j.change_id is null then
    update public.sandboxes set opened_at = now() where member_id = j.subject;
    update public.jobs set status = 'done', finished_at = now(), lease_until = null where id = j.id;
    return null;
  end if;
  -- One change taken back out of the copy. A connection from before this answers without saying (it only looked), and
  -- then nothing happened: the change can be taken back again later.
  if j.kind = 'sandbox' and j.brief = 'undo' then
    update public.sandbox_changes
       set undone = case when info ? 'undone' then case when (info ->> 'undone')::boolean then 'undone' else 'stuck' end else null end
     where id = j.change_id and undone = 'undoing';
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

  if j.kind = 'notes' then
    update public.jobs set status = 'done', finished_at = now(), lease_until = null, usage = public.kept_usage(info -> 'usage') where id = j.id;
    update public.chats set noted_at = j.created_at where id = j.chat_id and (noted_at is null or noted_at < j.created_at);
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
    end if;
    -- An early run that is not needed after all is stopped; one already under way as the look is kept.
    if act <> 'look' then
      update public.jobs set status = 'skipped', lease_until = null, error = 'not needed'
       where question_id = j.question_id and kind = 'look' and early and status in ('queued', 'running');
    end if;
    if act = 'look' and exists (select 1 from public.jobs e where e.question_id = j.question_id and e.kind = 'look' and e.early and e.status in ('queued', 'running', 'done')) then
      null;
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
      -- A full name exactly; else a first name, only when exactly one person here has it.
      select mem.id into target
        from public.members mem join public.connections cn on cn.member_id = mem.id
       where mem.table_id = j.table_id and mem.role in ('owner', 'developer') and mem.id <> j.member_id and mem.removed_at is null and public.member_sees_chat(j.chat_id, mem.id)
         and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
         and lower(btrim(mem.display_name)) = lower(btrim(p ->> 'to'))
       limit 1;
      if target is null then
        select (array_agg(distinct mem.id))[1], count(distinct mem.id) into target, matches
          from public.members mem join public.connections cn on cn.member_id = mem.id
         where mem.table_id = j.table_id and mem.role in ('owner', 'developer') and mem.id <> j.member_id and mem.removed_at is null and public.member_sees_chat(j.chat_id, mem.id)
           and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
           and split_part(lower(btrim(mem.display_name)), ' ', 1) = lower(btrim(p ->> 'to'));
        if matches <> 1 then
          target := null;
        end if;
      end if;
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

CREATE OR REPLACE FUNCTION public.judge_change(change uuid, answer text, said text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if ch.test then
    raise exception 'that one was your own test';
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
  -- "Not this" takes it back out of their copy too, so what they try is what the team means to keep.
  if answer = 'no' then
    perform public.undo_in_copy(ch);
  end if;
  perform public.log_activity(ch.table_id, me, 'sandbox.' || answer, ch.id, jsonb_build_object('client', who.display_name));
  return tk;
end;
$function$

;

CREATE OR REPLACE FUNCTION public.github_event(t uuid, signature text, event text, payload text, delivery text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  cmp_key bytea := extensions.gen_random_bytes(32);
  h public.github_hooks;
  p jsonb;
  line text;
  general uuid;
  owner_id uuid;
  ref text;
  n int;
  sha text;
  built uuid;
  asked text;
begin
  select * into h from public.github_hooks where table_id = t;
  if not found or signature is null
     -- Compared in constant time: both sides are hashed again under a key made fresh for this one comparison, so how
     -- long it takes says nothing about how much of a forged signature was right.
     or extensions.hmac(convert_to(signature, 'utf8'), cmp_key, 'sha256')
        <> extensions.hmac(convert_to('sha256=' || encode(extensions.hmac(convert_to(coalesce(payload, ''), 'utf8'), convert_to(h.secret, 'utf8'), 'sha256'), 'hex'), 'utf8'), cmp_key, 'sha256') then
    return 'refused';
  end if;
  begin
    p := payload::jsonb;
  exception when others then
    return 'refused';
  end;
  -- The same delivery a second time is a replay: it is ignored. Deliveries are remembered for a day.
  if coalesce(delivery, '') <> '' then
    delete from public.github_deliveries where at < now() - interval '1 day';
    insert into public.github_deliveries (table_id, delivery) values (t, left(delivery, 100)) on conflict do nothing;
    if not found then
      return 'ignored';
    end if;
  end if;
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
    -- Which client's copy this build is of: by its branch, or by a commit pushed to it.
    sha := coalesce(p #>> '{deployment,sha}', '');
    select s.member_id into built from public.sandboxes s
     where s.table_id = t
       and (s.branch = p #>> '{deployment,ref}' or public.same_commit(s.tip, sha)
            or exists (select 1 from public.sandbox_changes c where c.member_id = s.member_id and public.same_commit(c.commit, sha)))
     limit 1;
    if built is null then
      return 'ignored';
    end if;
    if p #>> '{deployment_status,state}' = 'success' then
      -- Online: where it opens (when the hosting says), and that this commit is the one people now see.
      update public.sandboxes s
         set url = case when coalesce(p #>> '{deployment_status,environment_url}', p #>> '{deployment_status,target_url}', '') ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$'
                        then left(coalesce(p #>> '{deployment_status,environment_url}', p #>> '{deployment_status,target_url}'), 300) else s.url end,
             live_sha = case when sha ~ '^[0-9a-f]{7,40}$' then sha else s.live_sha end, deploys_seen = true
       where s.member_id = built;
      return 'noted';
    elsif p #>> '{deployment_status,state}' in ('failure', 'error') and sha ~ '^[0-9a-f]{7,40}$' then
      -- It did not build: the client is told in plain words on their change, and the team hears it in General.
      update public.sandboxes s set failed_sha = sha, deploys_seen = true where s.member_id = built;
      select c.words into asked from public.sandbox_changes c where c.member_id = built and public.same_commit(c.commit, sha) order by c.created_at desc limit 1;
      line := (select split_part(m.display_name, ' ', 1) from public.members m where m.id = built) || '''s copy did not build'
        || coalesce(' after "' || left(regexp_replace(asked, '\s+', ' ', 'g'), 80) || '"', '') || '. Their copy still shows the version before it.';
    elsif p #>> '{deployment_status,state}' in ('pending', 'queued', 'in_progress') then
      update public.sandboxes s set deploys_seen = true where s.member_id = built;
      return 'noted';
    else
      return 'ignored';
    end if;
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
$function$

;

CREATE OR REPLACE FUNCTION public.close_sandbox()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- Taking one back whose job is gone (its computer went away): nothing came out, so it can be asked again.
  update public.sandbox_changes c set undone = null
   where c.undone = 'undoing'
     and not exists (select 1 from public.jobs j where j.change_id = c.id and j.brief = 'undo' and j.status in ('queued', 'running', 'waiting'));
end;
$function$

;

CREATE OR REPLACE FUNCTION public.client_sandbox(t uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me public.members;
  sb public.sandboxes;
begin
  select * into me from public.members where id = public.client_seat(t);
  if not found or me.role <> 'client' then
    raise exception 'only the client has a sandbox';
  end if;
  select * into sb from public.sandboxes where member_id = me.id;
  return jsonb_build_object(
    'on', coalesce(sb.mode = 'sandbox', false),
    'url', sb.url,
    -- Its newest commit is not online yet (only where the hosting reports its builds, and for twenty minutes at most).
    'building', coalesce(sb.deploys_seen and sb.tip is not null and sb.tip_at > now() - interval '20 minutes'
                  and not public.same_commit(sb.tip, sb.live_sha) and not public.same_commit(sb.tip, sb.failed_sha), false),
    -- Its newest commit did not build: the copy still shows the version before it.
    'broken', coalesce(sb.tip is not null and public.same_commit(sb.tip, sb.failed_sha), false),
    'left', (select greatest(0, ts.cap - (select count(*) from public.sandbox_changes c where c.member_id = me.id and c.created_at > now() - interval '24 hours' and not c.test)::integer)
               from public.table_sandbox ts where ts.table_id = t),
    'changes', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'words', c.words, 'status', c.status, 'summary', c.summary,
                  'verdict', c.verdict, 'note', c.note, 'request_id', c.request_id, 'created_at', c.created_at, 'finished_at', c.finished_at,
                  'undone', c.undone, 'did_not_build', public.same_commit(c.commit, sb.failed_sha))
                  order by c.created_at desc), '[]'::jsonb)
                  from (select * from public.sandbox_changes x where x.member_id = me.id and not x.test order by x.created_at desc limit 60) c));
end;
$function$

;

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
            or (status = 'running' and lease_until < now() - interval '2 minutes'));
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
