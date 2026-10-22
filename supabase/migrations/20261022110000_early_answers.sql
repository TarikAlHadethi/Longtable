-- The answer starts with the listener, not after it. A message that is plainly for the AI (it names one, runs a
-- command, or asks a question without naming someone else at the table) gets its asker's own Claude started at the same
-- moment as the listener, marked early. When the listener says look, that run already is the look; when it says
-- anything else, the early run is stopped (its connection hears so within a few seconds) and nothing of it is posted
-- unless it had already finished. About five seconds sooner for every answer.

alter table public.jobs add column if not exists early boolean not null default false;

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
        insert into public.jobs (table_id, chat_id, member_id, question_id, kind, early) values (l.table_id, l.chat_id, who, latest, 'look', true);
      end if;
    end loop;
    if skipped is not null then
      insert into public.listens (chat_id, table_id, since, due_at) values (l.chat_id, l.table_id, skipped, now() + interval '5 seconds')
        on conflict (chat_id) do update set since = least(public.listens.since, excluded.since), due_at = least(public.listens.due_at, excluded.due_at);
    end if;
  end loop;
  return n;
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
