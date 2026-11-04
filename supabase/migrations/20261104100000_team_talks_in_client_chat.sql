-- A person on the team can write in a client's chat with the team's assistant, from the client's side of the table.
-- Their words show on the client's page under their own name, the assistant reads them in its history, and when the
-- client answers that person rather than asking anything, the assistant stays quiet instead of cutting in.
--
-- * client_lines.who gains 'team', with from_name for whose words they are. These lines are by_table, so whoever on
--   the team may read that conversation reads them. A chat with an assistant the client connected themselves stays
--   private: the team still cannot read the client's side of it.
-- * team_say(m, words): owners, and developers given the Clients switch. Never a client, never for a client who left.
-- * client_job_payload hands the name with each line and team_talking; runner_finish takes info.quiet, which a
--   connection before 0.1.48 never sends (it just reads a team line as its own, until it moves).

alter table public.client_lines drop constraint client_lines_who_check;
alter table public.client_lines add constraint client_lines_who_check check (who in ('client', 'assistant', 'team'));
alter table public.client_lines add column from_name text;
alter table public.client_lines add column quiet boolean not null default false;
grant select (from_name, quiet) on public.client_lines to authenticated;

create function public.team_say(m uuid, words text) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  who public.members;
  me public.members;
  clean text := public.hide_secrets(btrim(coalesce(words, '')));
  line uuid;
begin
  select * into who from public.members where id = m and role = 'client' and removed_at is null;
  if not found or not public.may(who.table_id, 'clients') then raise exception 'you cannot write in this chat'; end if;
  if clean = '' then raise exception 'there is nothing to send'; end if;
  if char_length(clean) > 4000 then raise exception 'that is too long to send'; end if;
  select * into me from public.members where table_id = who.table_id and user_id = auth.uid() and removed_at is null;
  insert into public.client_lines (table_id, member_id, who, body, by_table, from_name)
    values (who.table_id, who.id, 'team', clean, true, me.display_name) returning id into line;
  -- Words waiting for a team AI to come on have now been answered by a person: the client is no longer told to wait, and
  -- no AI answers them hours later. They already reached the team as a request.
  update public.client_lines set waiting = false where member_id = who.id and waiting;
  perform public.log_activity(who.table_id, me.id, 'client.team_said', null, jsonb_build_object('client', who.id));
  return line;
end;
$$;
revoke all on function public.team_say(uuid, text) from public, anon;
grant execute on function public.team_say(uuid, text) to authenticated;

CREATE OR REPLACE FUNCTION public.client_job_payload(j jobs)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'job_id', j.id,
    'kind', 'client', 'for_team', j.subject is not null,
    -- A deeper look (stage 1): the question the team's assistant wrote, for a team Claude that reads the code.
    'stage', coalesce(j.stage, 0), 'brief', case when coalesce(j.stage, 0) = 1 then j.brief end,
    'can_look', j.subject is not null and coalesce(j.stage, 0) = 0 and public.client_look_seat(j.table_id) is not null,
    -- They have a copy of their own: a change they ask for can be tried in it (the team's assistant decides).
    'has_copy', j.subject is not null and coalesce(j.stage, 0) = 0
      and exists (select 1 from public.sandboxes s where s.member_id = j.subject and s.mode = 'sandbox'),
    -- A person on the team wrote in this chat in the last 15 minutes: the two of them may be talking, and the team's
    -- assistant may then stay out of it (quiet).
    'team_talking', j.subject is not null and coalesce(j.stage, 0) = 0 and exists (select 1 from public.client_lines l
      where l.member_id = j.subject and l.who = 'team' and l.created_at > now() - interval '15 minutes'),
    -- Their words already reached the team as a request: answer, and never pass them on again.
    'already_passed', (select l.request_id is not null from public.client_lines l where l.id = j.line_id),
    -- What the team's AIs took on at this table, by title only: what is finished and what is under way. The owner
    -- chose to let a client hear this. Nothing of how it was done, who asked, or what was said about it.
    'work', coalesce((
      select jsonb_agg(jsonb_build_object('title', public.hide_secrets(left(w.title, 120)), 'status', w.status) order by w.created_at desc)
        from (select * from public.tasks t2 where t2.table_id = j.table_id and t2.status in ('working', 'done') and not public.chat_is_private(t2.chat_id)
                 -- Work the team took from a client's own copy is titled with that client's name and words:
                 -- it is not for another client's side to carry. The client it came from still hears of it,
                 -- and is known by their copy's own branch, which the work keeps.
                 and (t2.reference ->> 'branch' = (select s.branch from public.sandboxes s where s.member_id = coalesce(j.subject, j.member_id))
                      -- Everything else the team took on, except work whose title names another client at the
                      -- table: one client never hears of work about another.
                      or (t2.reference ->> 'client' is null
                          and not exists (select 1 from public.members o where o.table_id = j.table_id and o.role = 'client'
                                            and o.id <> coalesce(j.subject, j.member_id)
                                            and char_length(regexp_replace(split_part(btrim(o.display_name), ' ', 1), '[^[:alnum:]]', '', 'g')) > 1
                                            and lower(' ' || regexp_replace(t2.title, '[^[:alnum:]]+', ' ', 'g') || ' ')
                                                like '% ' || lower(regexp_replace(split_part(btrim(o.display_name), ' ', 1), '[^[:alnum:]]', '', 'g')) || ' %')))
                 order by t2.created_at desc limit 30) w), '[]'::jsonb),
    'table_name', (select name from public.tables where id = j.table_id),
    'me', (select display_name from public.members where id = coalesce(j.subject, j.member_id)),
    'question', (select body from public.client_lines where id = j.line_id),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'title', r.title, 'status', r.status, 'asked', r.created_at,
               'timeline', coalesce((select jsonb_agg(e.label order by e.id) from public.request_events e where e.request_id = r.id), '[]'::jsonb))
             order by r.created_at desc)
        from (select * from public.requests r2 where r2.member_id = coalesce(j.subject, j.member_id) order by r2.created_at desc limit 30) r), '[]'::jsonb),
    'told', coalesce((
      select jsonb_agg(jsonb_build_object('when', u.created_at, 'words', u.body, 'their_answer', u.answer) order by u.created_at desc)
        from (select * from public.client_updates u2
               where u2.table_id = j.table_id
                 and (u2.request_id is null or exists (select 1 from public.requests r3 where r3.id = u2.request_id and r3.member_id = coalesce(j.subject, j.member_id)))
               order by u2.created_at desc limit 30) u), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('who', l.who, 'body', l.body, 'name', l.from_name) order by l.created_at)
        from (select * from public.client_lines l2 where l2.member_id = coalesce(j.subject, j.member_id) and l2.id <> j.line_id
                 -- One of the team's AIs is only handed what was said to the team's assistant. What a client said to
                 -- an assistant they connected themselves is theirs, and the team does not read it.
                 and (j.subject is null or l2.by_table)
               order by l2.created_at desc limit 20) l), '[]'::jsonb));
$function$;

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
$function$;

update public.connect_release set version = '0.1.48', set_at = now();
