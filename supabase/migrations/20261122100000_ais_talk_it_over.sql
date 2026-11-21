-- The AIs at a table talk it over: every question answered by someone's Claude (a look) first hears the views of the
-- other AIs that are on, then that Claude writes the one answer with them. Before, only changes were discussed and a
-- question was answered by the asker's Claude alone, so asking it to check with a teammate's AI reached nobody.
-- When a message is plainly for the AIs the views start at once beside the listener; if the listener decides nothing
-- is wanted, they are stopped with the early look. Built from the live definitions, so nothing later is undone.

create or replace function public.start_look(t uuid, c uuid, q uuid, writer uuid, early_ boolean) returns void
  language plpgsql security definer set search_path to ''
as $$
declare
  r uuid := gen_random_uuid();
  s uuid;
  others integer := 0;
begin
  for s in select distinct cn.member_id
             from public.connections cn join public.members m on m.id = cn.member_id
            where cn.table_id = t and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds'
              and m.role in ('owner', 'developer') and m.removed_at is null and public.member_sees_chat(c, m.id)
              and cn.member_id <> writer loop
    insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, early) values (t, c, s, q, 'view', r, early_);
    others := others + 1;
  end loop;
  -- With nobody else on, the look starts now; else it waits for the views (release_rounds, at most 90 seconds).
  insert into public.jobs (table_id, chat_id, member_id, question_id, kind, early, round, status)
    values (t, c, writer, q, 'look', early_, case when others > 0 then r end,
            case when others > 0 then 'waiting'::public.job_status else 'queued'::public.job_status end);
end;
$$;
revoke all on function public.start_look(uuid, uuid, uuid, uuid, boolean) from public, anon, authenticated;

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
  sb public.sandboxes;
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
    -- Their words were meant for the person on the team talking with them: the assistant says nothing. The line is
    -- marked so their page stops showing the answer forming. Only ever while a person is talking there (team_talking).
    if j.subject is not null and coalesce(j.stage, 0) = 0 and coalesce((info ->> 'quiet')::boolean, false)
       and exists (select 1 from public.client_lines l where l.member_id = j.subject and l.who = 'team' and l.created_at > now() - interval '30 minutes') then
      update public.client_lines set quiet = true where id = j.line_id;
      update public.jobs set status = 'done', finished_at = now(), lease_until = null, usage = public.kept_usage(info -> 'usage') where id = j.id;
      return null;
    end if;
    select * into line from public.client_lines where id = j.line_id;
    -- A change for a client's own copy: the team's assistant said so (copy), or a connection from before it could say
    -- so passed on a client who has a copy. Built in the copy like any change they make there; the copy's own words
    -- tell them how it went, so the assistant writes nothing. If the copy cannot take it now, it is passed on.
    if j.subject is not null and coalesce(j.stage, 0) = 0 and line.request_id is null
       and exists (select 1 from public.sandboxes s where s.member_id = j.subject and s.mode = 'sandbox')
       and (coalesce((info ->> 'copy')::boolean, false)
            or (not (info ? 'copy') and coalesce((info ->> 'pass_on')::boolean, true))) then
      target := public.copy_seat(j.table_id);
      select count(*)::integer into matches from public.sandbox_changes x where x.member_id = j.subject and x.created_at > now() - interval '24 hours' and not x.test;
      if target is not null and coalesce(matches < (select ts.cap from public.table_sandbox ts where ts.table_id = j.table_id), true) then
        insert into public.sandbox_changes (table_id, member_id, words)
          values (j.table_id, j.subject, coalesce(nullif(btrim(left(public.hide_secrets(info ->> 'change'), 2000)), ''), line.body)) returning * into ch;
        insert into public.jobs (table_id, member_id, kind, change_id) values (j.table_id, target, 'sandbox', ch.id);
        update public.jobs set status = 'done', finished_at = now(), lease_until = null, usage = public.kept_usage(info -> 'usage') where id = j.id;
        return null;
      end if;
      -- The copy cannot take it now (no team Claude on, the computer that builds copies is off, or the day's changes
      -- used up): it goes to the team, and the
      -- client is told so instead of "trying it in your copy".
      passing := true;
      clean := case
        when target is not null then 'You''ve used today''s changes for your copy, so I''ve left the team a message about it. You''ll hear back here.'
        when public.copy_builder(j.table_id) is not null then
          (select split_part(m.display_name, ' ', 1) from public.members m where m.id = public.copy_builder(j.table_id))
          || '''s computer is off right now, so I''ve left them a message. You''ll hear back here.'
        else 'The team''s computers are off right now, so I''ve left them a message. You''ll hear back here.' end;
    end if;
    passing := coalesce(passing, false) or (coalesce((info ->> 'pass_on')::boolean, true) and not coalesce((info ->> 'copy')::boolean, false)) or btrim(clean) = '';
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
  -- Whether the copy could take in the team's latest. Falling behind is said once to the team in General (the client's
  -- page says it too); catching up again clears it.
  if j.kind = 'sandbox' and info ? 'stale' then
    select s.* into sb from public.sandboxes s
     where s.member_id = coalesce(j.subject, (select sc.member_id from public.sandbox_changes sc where sc.id = j.change_id)) for update;
    if found and coalesce((info ->> 'stale')::boolean, false) and sb.behind_since is null then
      update public.sandboxes set behind_since = now() where member_id = sb.member_id;
      insert into public.messages (table_id, chat_id, member_id, body, kind, meta)
        select sb.table_id, ch2.id, (select tb.main_owner from public.tables tb where tb.id = sb.table_id),
               (select split_part(m.display_name, ' ', 1) from public.members m where m.id = sb.member_id)
                 || '''s copy no longer fits your latest work: some of your changes clash with theirs, so their copy stays on an older version. They have been told. It catches up by itself once the two fit again.',
               'github', jsonb_build_object('event', 'copy_behind')
          from public.chats ch2 where ch2.table_id = sb.table_id and ch2.is_general;
    elsif found and not coalesce((info ->> 'stale')::boolean, false) and sb.behind_since is not null then
      update public.sandboxes set behind_since = null where member_id = sb.member_id;
    end if;
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
       where question_id = j.question_id and kind in ('look', 'view') and early and status in ('queued', 'running', 'waiting');
    end if;
    if act = 'look' and exists (select 1 from public.jobs e where e.question_id = j.question_id and e.kind = 'look' and e.early and e.status in ('queued', 'running', 'waiting', 'done')) then
      null;
    elsif act = 'look' then
      -- A look is done by the Claude of whoever asked, when it is on: it is the one that knows what they know. Else by
      -- the table's seat. The other AIs that are on give their views first.
      perform public.start_look(j.table_id, j.chat_id, j.question_id,
        coalesce((select cn.member_id from public.connections cn
                   where cn.member_id = q.member_id and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds' limit 1), j.member_id),
        false);
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
  if j.kind = 'combine' or (j.kind = 'look' and j.round is not null) then
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
$function$;

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
      and (chat_id is null or public.member_sees_chat(chat_id, member_id))
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
    -- Each message's id, and for an AI's answer the job that wrote it, so a session can tell what it already has.
    select m.id, m.created_at, m.body, m.by_ai, m.kind = 'client' as client, case when m.kind = 'github' then 'GitHub' else mem.display_name end as name,
           (select jj.id from public.jobs jj where jj.result_message_id = m.id limit 1) as job_id,
           m.meta -> 'pasted' as pasted
      from public.messages m join public.members mem on mem.id = m.member_id
     where m.chat_id = j.chat_id and m.kind in ('chat', 'answer', 'client', 'github') and not m.no_ai
       -- A job with no question of its own (the note-taker's) gets the whole conversation.
       and m.created_at < coalesce(q.created_at, now()) and (j.question_id is null or m.id <> j.question_id)
     order by m.created_at desc
     -- The listener reads only the newest part (24,000 characters); the jobs that answer may read it all.
     limit case when j.kind = 'listen' then 150 else 400 end
  ) x;

  if j.kind in ('combine', 'work', 'review', 'plan') or (j.kind = 'look' and j.round is not null) then
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
       where m.table_id = j.table_id and m.kind in ('chat', 'answer', 'client') and m.id <> q.id and not m.no_ai
         and m.search @@ public.loose_query(q.body)
         and m.id not in (select m2.id from public.messages m2 where m2.chat_id = j.chat_id order by m2.created_at desc limit 21)
         and public.member_sees_chat(m.chat_id, c.member_id)
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
    'chat_id', j.chat_id, 'question_id', j.question_id,
    'chat_name', (select name from public.chats where id = j.chat_id),
    'chat_private', public.chat_is_private(j.chat_id),
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
    'pages', case when j.kind in ('look', 'answer', 'work', 'combine', 'notes') then public.pages_for_job(j) else '[]'::jsonb end,
    -- The person's own choices for their AI's runs.
    'effort', c.effort, 'fast', c.fast, 'mode', c.mode, 'in_folder', c.in_folder, 'push_anywhere', c.push_anywhere, 'browser', c.browser, 'use_repo', c.use_repo,
    -- Where the team shares its code, as the owner set it: the connection reads and lands work there when its own
    -- copy of the project knows that repository.
    'repo', (select tc.repo_url from public.table_code tc where tc.table_id = j.table_id),
    -- The person runs their AI as their full Claude Code (their own rules, approvals on their screen), and only for
    -- their own request: a teammate's or a client's message never drives their full Claude Code.
    'full', coalesce(c.kind = 'claude' and c.full_claude and q.member_id = c.member_id and j.kind not in ('intro', 'combine'), false),
    'question', q.body, 'question_pasted', q.meta -> 'pasted',
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
                and cn.last_seen > now() - interval '60 seconds' and cn.member_id <> c.member_id
                and (j.chat_id is null or public.member_sees_chat(j.chat_id, cn.member_id))),
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
                   and public.member_sees_chat(tk.chat_id, c.member_id)
                 order by tk.created_at desc limit 8) x),
    'worker', (select mem.display_name from public.jobs w join public.members mem on mem.id = w.member_id where w.round = j.round and w.kind = 'work' limit 1),
    'work_read', (select m.meta ->> 'read' from public.jobs w join public.messages m on m.id = w.result_message_id
                   where w.round = j.round and w.kind = 'work' and w.status = 'done' and coalesce((w.outcome ->> 'changed')::boolean, false)
                   order by w.stage desc limit 1),
    'related', related,
    'pinned', pinned);
end;
$function$;

CREATE OR REPLACE FUNCTION public.release_rounds()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  w public.jobs;
  n integer := 0;
begin
  for w in select * from public.jobs where kind in ('combine', 'look') and status = 'waiting' for update skip locked loop
    if not exists (select 1 from public.jobs v where v.round = w.round and v.kind = 'view' and v.status in ('queued', 'running'))
       or w.created_at < now() - interval '90 seconds' then
      update public.jobs set status = 'skipped', error = 'did not answer in time'
        where round = w.round and kind = 'view' and status = 'queued';
      -- A look is timed from when it can start, or the listener's 45 seconds would drop it at once.
      update public.jobs set status = 'queued', created_at = case when w.kind = 'look' then now() else created_at end where id = w.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$function$;

CREATE OR REPLACE FUNCTION public.listen_now()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  l public.listens;
  who uuid;
  strong boolean;
  weak boolean;
  after_ai boolean;
  latest uuid;
  seat uuid;
  n integer := 0;
  skipped timestamptz;
begin
  update public.jobs set status = 'skipped', lease_until = null, error = 'nobody picked it up'
   where kind in ('listen', 'look')
     and ((status = 'queued' and created_at < now() - interval '45 seconds')
       or (status = 'running' and lease_until < now() - interval '1 minute'));
  for l in select * from public.listens where due_at <= now() for update skip locked loop
    if exists (select 1 from public.jobs j where j.chat_id = l.chat_id and j.status in ('queued', 'running', 'waiting')
                 and j.kind in ('listen', 'look')) then
      continue;
    end if;
    delete from public.listens where chat_id = l.chat_id;
    seat := public.final_seat_now(l.table_id);
    continue when seat is null;
    -- Was the last thing said before these messages said by an AI, a little while ago?
    skipped := null;
    after_ai := coalesce((select p.by_ai from public.messages p
                           where p.chat_id = l.chat_id and p.kind in ('chat', 'answer') and p.created_at < l.since
                             and p.created_at > l.since - interval '15 minutes'
                           order by p.created_at desc limit 1), false);
    -- Each person who wrote is heard on their own: two people asking for two things at the same moment are two
    -- requests, and each goes to its own person's AI.
    for who in select distinct m.member_id from public.messages m
                where m.chat_id = l.chat_id and m.kind = 'chat' and not m.by_ai and m.created_at >= l.since and not public.message_taken(m.id) loop
      -- Their own AI is at work on their request in this chat and taking what they say into it, as at home: it gets
      -- these messages itself. They are heard again once that work ends, so nothing it did not get is lost.
      if exists (select 1 from public.jobs tj join public.messages tq on tq.id = tj.question_id
                  where tj.chat_id = l.chat_id and tj.taking and tj.status = 'running' and tj.lease_until > now() and tq.member_id = who) then
        skipped := least(coalesce(skipped, 'infinity'::timestamptz), (select min(m2.created_at) from public.messages m2
                    where m2.chat_id = l.chat_id and m2.member_id = who and m2.kind = 'chat' and not m2.by_ai and m2.created_at >= l.since));
        continue;
      end if;
      select coalesce(bool_or(char_length(m.body) >= 40
                 or m.body ~ '^\s*/[A-Za-z]' or m.body ~* '\?|@|\m(ai|ais|claude|chatgpt|gpt|codex|table|longtable)\M'
                 or m.body ~* '^\s*(can|could|would|will|please|pls|make|add|fix|change|update|remove|delete|build|write|check|look|why|how|what|where|when|which|who|should|is|are|does|do|did|implement|create|refactor|rename|move|review|explain|tell|show|find|lets|let''s|try|use|set|put|run|test|ship|revert|undo)\M'), false),
             coalesce(bool_or(m.body ~* '^\s*(yes|yeah|yep|no|nah|ok|okay|sure|go)\M'), false)
        into strong, weak
        from public.messages m
       where m.chat_id = l.chat_id and m.kind = 'chat' and not m.by_ai and m.created_at >= l.since and not public.message_taken(m.id) and m.member_id = who;
      -- Anything said straight after an AI spoke is heard, whatever its shape: it is most likely an answer to it.
      -- In a chat whose AIs answer only when named, only a message that names one (or runs a command) is heard.
      if (select ch.answers from public.chats ch where ch.id = l.chat_id) = 'named' then
        continue when not exists (select 1 from public.messages m where m.chat_id = l.chat_id and m.kind = 'chat' and not m.by_ai
          and m.created_at >= l.since and m.member_id = who and not public.message_taken(m.id)
          and (m.body ~ '^\s*/[A-Za-z]' or m.body ~* '@|\m(ai|ais|claude|chatgpt|gpt|codex|table|longtable)\M'));
      else
        continue when not (strong or after_ai);
      end if;
      select m.id into latest from public.messages m
       where m.chat_id = l.chat_id and m.kind = 'chat' and not m.by_ai and m.created_at >= l.since and not public.message_taken(m.id) and m.member_id = who
       order by m.created_at desc limit 1;
      -- A message that was asked outright already has the AIs on it.
      -- A message that was asked outright already has the AIs on it, and one already heard is not heard again (the chat's
      -- window can reach back over it while someone's own run takes their words).
      continue when latest is null or exists (select 1 from public.jobs j where j.question_id = latest);
      insert into public.jobs (table_id, chat_id, member_id, question_id, kind) values (l.table_id, l.chat_id, seat, latest, 'listen');
      n := n + 1;
      -- Plainly for the AI, and their own Claude is on: it starts now, beside the listener.
      if exists (select 1 from public.messages m join public.members me on me.id = m.member_id
                  where m.id = latest and me.role in ('owner', 'developer') and me.removed_at is null
                    and (m.body ~ '^\s*/[A-Za-z]' or m.body ~* '\m(ai|ais|claude|chatgpt|gpt|codex|table|longtable)\M'
                      or (m.body ~ '\?' and not exists (
                            select 1 from public.members o
                             where o.table_id = l.table_id and o.id <> who and o.removed_at is null
                               and char_length(split_part(btrim(o.display_name), ' ', 1)) >= 2
                               and m.body ~* ('\m' || regexp_replace(split_part(btrim(o.display_name), ' ', 1), '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '\M')))))
         and exists (select 1 from public.connections cn
                      where cn.member_id = who and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds')
         and public.member_sees_chat(l.chat_id, who) then
        perform public.start_look(l.table_id, l.chat_id, latest, who, true);
      end if;
    end loop;
    if skipped is not null then
      insert into public.listens (chat_id, table_id, since, due_at) values (l.chat_id, l.table_id, skipped, now() + interval '5 seconds')
        on conflict (chat_id) do update set since = least(public.listens.since, excluded.since), due_at = least(public.listens.due_at, excluded.due_at);
    end if;
  end loop;
  return n;
end;
$function$;
