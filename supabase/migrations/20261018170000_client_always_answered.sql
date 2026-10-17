-- A client is always answered (17 Oct 2026: no "They have your message. Their answer will show here" any more, an
-- AI always replies; the table answers by itself when it can and asks the team's AIs only when it must; and a
-- setting for which AI answers each client).
--
-- * A client with no copy is always answered by an AI. Who: their own assistant when they connected one and the
--   owner lets it answer (the default), otherwise the team's assistant. With no team AI on, their words wait
--   (`client_lines.waiting`) and are answered the moment one comes on; they no longer fall straight to a request.
-- * The team's assistant answers from what the client may know. When that is not enough it asks a team Claude that
--   can read the code, in its own words (`look`, `ask`): a second client job (stage 1) whose answer is the reply. The
--   client's own words never reach the AI that reads the code.
-- * A desk job no computer took is handed to the next one that is on, up to three times, before it becomes a
--   request.
-- * The client's page hears which stage its answer is at, to show the reply forming.

alter table public.client_lines add column waiting boolean not null default false;
grant select (waiting) on public.client_lines to authenticated;

create table public.client_settings (
  member_id uuid primary key references public.members(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  answered_by text not null default 'own' check (answered_by in ('own', 'table')),
  updated_at timestamptz not null default now()
);
alter table public.client_settings enable row level security;
revoke all on public.client_settings from anon, authenticated;
grant select on public.client_settings to authenticated;
create policy "the team sees how its clients are answered" on public.client_settings for select using (public.is_team(table_id));

-- Who answers a client: 'own' (their own assistant when it is on, else the team's) or 'table' (always the team's).
create function public.set_client_answerer(m uuid, who text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c public.members;
begin
  select * into c from public.members where id = m and role = 'client' and removed_at is null;
  if not found or not public.is_owner(c.table_id) then
    raise exception 'only the owner sets who answers a client';
  end if;
  if who not in ('own', 'table') then
    raise exception 'a client is answered by their own assistant or by the table';
  end if;
  insert into public.client_settings (member_id, table_id, answered_by) values (c.id, c.table_id, who)
    on conflict (member_id) do update set answered_by = excluded.answered_by, updated_at = now();
end;
$$;
revoke all on function public.set_client_answerer(uuid, text) from public, anon;
grant execute on function public.set_client_answerer(uuid, text) to authenticated;

-- The team seat that answers a client right now: any of the team's AIs that is on, the table's own first.
create function public.client_desk_seat(t uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select cn.member_id
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer') and m.removed_at is null
   where cn.table_id = t and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds'
   order by (cn.member_id = public.final_seat_now(t)) desc, cn.created_at limit 1;
$$;
-- The team Claude that can read the code for a client's deeper question.
create function public.client_look_seat(t uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select cn.member_id
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer') and m.removed_at is null
   where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
   order by (cn.member_id = public.final_seat_now(t)) desc, cn.created_at limit 1;
$$;
revoke all on function public.client_desk_seat(uuid), public.client_look_seat(uuid) from public, anon, authenticated;

-- Words that waited for a team AI to come on are answered as soon as one does.
create function public.answer_waiting_clients()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  w record;
  seat uuid;
  n integer := 0;
begin
  for w in
    select l.* from public.client_lines l join public.members m on m.id = l.member_id and m.removed_at is null
     where l.waiting and l.who = 'client'
       and not exists (select 1 from public.jobs j where j.line_id = l.id and j.status in ('queued', 'running'))
     order by l.created_at limit 20
     for update of l skip locked
  loop
    seat := public.client_desk_seat(w.table_id);
    continue when seat is null;
    insert into public.jobs (table_id, member_id, kind, line_id, subject) values (w.table_id, seat, 'client', w.id, w.member_id);
    update public.client_lines set waiting = false where id = w.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.answer_waiting_clients() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.client_say(t uuid, body text, files jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me public.members;
  words text := btrim(coalesce(body, ''));
  ai public.connections;
  sb public.sandboxes;
  line uuid;
  job uuid;
  seat uuid;
  change uuid;
  used integer;
  most integer;
  req uuid;
  has boolean := coalesce(jsonb_array_length(files), 0) > 0;
begin
  -- One of this person's messages at a time, so two sent together cannot both slip under a limit.
  -- Still at the table is checked again once the row is ours: taken off while this waited for it, they are not.
  select * into me from public.members where id = public.client_seat(t) and removed_at is null for update;
  if not found or me.role <> 'client' then
    raise exception 'only the client asks here';
  end if;
  if char_length(words) = 0 and not has then
    raise exception 'ask for something';
  end if;
  if char_length(words) = 0 then
    words := left((select string_agg(f ->> 'name', ', ') from jsonb_array_elements(files) f), 500);
  end if;
  if public.client_said_lately(me.id) + (select count(*) from public.sandbox_changes c where c.member_id = me.id and c.created_at > now() - interval '1 hour' and not c.test)::integer >= 60 then
    raise exception 'that is a lot of requests in one hour, try again a little later';
  end if;
  -- Something attached is for people to look at: it goes straight to the team as a request, with the files on it.
  if has then
    req := public.pass_on_request(me.id, words, null, null, true);
    perform public.take_files(t, me.id, files, (select r.message_id from public.requests r where r.id = req));
    update public.messages mm set meta = mm.meta || jsonb_build_object('files',
        (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'mime', a.mime, 'size', a.size, 'path', a.path, 'kind', a.kind) order by a.created_at), '[]'::jsonb)
           from public.attachments a where a.message_id = mm.id))
     where mm.id = (select r.message_id from public.requests r where r.id = req);
    update public.requests r set files = (select mm.meta -> 'files' from public.messages mm where mm.id = r.message_id) where r.id = req;
    return jsonb_build_object('request', req);
  end if;
  if char_length(words) > 4000 then
    raise exception 'that is a lot for one message; keep it under 4,000 characters';
  end if;

  select * into sb from public.sandboxes where member_id = me.id and mode = 'sandbox';
  if found then
    -- The team's Claude that speaks for the table, if it is on; else any of the team's Claudes that is.
    select cn.member_id into seat
      from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
     where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
     order by (cn.member_id = public.final_seat_now(t)) desc, cn.created_at limit 1;
    -- Every change counts against the day, whatever came of it: each one is a run of the team's AI.
    select count(*) into used from public.sandbox_changes c where c.member_id = me.id and c.created_at > now() - interval '24 hours' and not c.test;
    -- No number means as many as they like.
    select ts.cap into most from public.table_sandbox ts where ts.table_id = t;
    if seat is not null and (most is null or used < most) then
      insert into public.sandbox_changes (table_id, member_id, words) values (t, me.id, words) returning id into change;
      insert into public.jobs (table_id, member_id, kind, change_id) values (t, seat, 'sandbox', change) returning id into job;
      return jsonb_build_object('change', change, 'left', most - used - 1);
    end if;
    -- The sandbox cannot take it right now. The words still reach the team, and the client is told why.
    return jsonb_build_object('request', public.pass_on_request(me.id, words, null, null, true),
      'why', case when seat is null then 'asleep' else 'full' end);
  end if;

  select * into ai from public.connections
   where member_id = me.id and revoked_at is null and last_seen > now() - interval '60 seconds'
   order by last_seen desc limit 1;
  if not found or coalesce((select cs.answered_by from public.client_settings cs where cs.member_id = me.id), 'own') = 'table' then
    -- The team's assistant answers, from what this client may know. With no team AI on, the words reach the team and
    -- wait for an AI, which answers the moment one comes on (answer_waiting_clients).
    seat := public.client_desk_seat(t);
    insert into public.client_lines (table_id, member_id, who, body, by_table, waiting) values (t, me.id, 'client', words, true, seat is null) returning id into line;
    if seat is null then
      -- Nobody's AI is on: the team still sees it in their chat at once, and an AI answers the client the moment one
      -- comes on.
      perform public.pass_on_request(me.id, words, null, line, false);
      return jsonb_build_object('line', line, 'waiting', true);
    end if;
    insert into public.jobs (table_id, member_id, kind, line_id, subject) values (t, seat, 'client', line, me.id) returning id into job;
    return jsonb_build_object('line', line, 'job', job);
  end if;
  insert into public.client_lines (table_id, member_id, who, body) values (t, me.id, 'client', words) returning id into line;
  insert into public.jobs (table_id, member_id, kind, line_id) values (t, me.id, 'client', line) returning id into job;
  return jsonb_build_object('line', line, 'job', job);
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
      -- A full name exactly; else a first name, only when exactly one person here has it.
      select mem.id into target
        from public.members mem join public.connections cn on cn.member_id = mem.id
       where mem.table_id = j.table_id and mem.role in ('owner', 'developer') and mem.id <> j.member_id and mem.removed_at is null
         and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
         and lower(btrim(mem.display_name)) = lower(btrim(p ->> 'to'))
       limit 1;
      if target is null then
        select (array_agg(distinct mem.id))[1], count(distinct mem.id) into target, matches
          from public.members mem join public.connections cn on cn.member_id = mem.id
         where mem.table_id = j.table_id and mem.role in ('owner', 'developer') and mem.id <> j.member_id and mem.removed_at is null
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

CREATE OR REPLACE FUNCTION public.client_job_timeouts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  stale record;
  n integer := 0;
begin
  perform public.answer_waiting_clients();
  for stale in
    select id, status from public.jobs
     where kind = 'client'
       and ((status = 'queued' and created_at < now() - interval '180 seconds')
         or (status = 'running' and coalesce(started_at, created_at) < now() - (case when stage = 1 then interval '240 seconds' else interval '100 seconds' end)))
  loop
    perform public.give_up_client_job(stale.id, case when stale.status = 'queued' then 'not picked up in 3 minutes' else 'no answer in 100 seconds' end);
    n := n + 1;
  end loop;
  return n;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.give_up_client_job(job uuid, reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  j public.jobs;
  line public.client_lines;
  req uuid;
begin
  select * into j from public.jobs where id = job and kind = 'client' for update;
  if not found or j.status in ('done', 'failed') then
    return;
  end if;
  update public.jobs set status = 'failed', error = public.kept_line(reason, 500), lease_until = null, finished_at = now() where id = j.id;
  select * into line from public.client_lines where id = j.line_id;
  -- The team's assistant: handed to the next team AI that is on, up to three tries, before it becomes a request.
  if j.subject is not null and (select count(*) from public.jobs x where x.line_id = j.line_id) < 3 then
    -- The team sees it now, if it has not yet; the next team AI that is on answers the client.
    if line.request_id is null then
      perform public.pass_on_request(j.subject, line.body, null, line.id, false);
    end if;
    update public.client_lines set waiting = true where id = line.id;
    return;
  end if;
  req := public.pass_on_request(coalesce(j.subject, j.member_id), line.body, null, line.id, false);
  insert into public.client_lines (table_id, member_id, who, body, request_id, by_table)
    values (j.table_id, coalesce(j.subject, j.member_id), 'assistant', 'Passed on to the team, since I could not answer that just now. You will hear here what they decide.', req, j.subject is not null);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.broadcast_job_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.kind = 'client' and new.subject is not null and new.subject <> new.member_id then
    -- Answered by the team's assistant: the client hears it on their own channel, and only which job and its state.
    perform realtime.send(jsonb_build_object('table', 'jobs', 'record', jsonb_build_object('id', new.id, 'kind', new.kind, 'status', new.status, 'member_id', new.subject, 'created_at', new.created_at, 'stage', coalesce(new.stage, 0))),
      tg_op, 'client:' || new.table_id::text || ':' || new.subject::text, true);
  elsif new.kind = 'client' then
    perform realtime.broadcast_changes('client:' || new.table_id::text || ':' || new.member_id::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, null);
  else
    perform realtime.broadcast_changes('team:' || new.table_id::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
  end if;
  return null;
end;
$function$
;

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
    -- Their words already reached the team as a request: answer, and never pass them on again.
    'already_passed', (select l.request_id is not null from public.client_lines l where l.id = j.line_id),
    -- What the team's AIs took on at this table, by title only: what is finished and what is under way. The owner
    -- chose to let a client hear this. Nothing of how it was done, who asked, or what was said about it.
    'work', coalesce((
      select jsonb_agg(jsonb_build_object('title', public.hide_secrets(left(w.title, 120)), 'status', w.status) order by w.created_at desc)
        from (select * from public.tasks t2 where t2.table_id = j.table_id and t2.status in ('working', 'done')
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
      select jsonb_agg(jsonb_build_object('who', l.who, 'body', l.body) order by l.created_at)
        from (select * from public.client_lines l2 where l2.member_id = coalesce(j.subject, j.member_id) and l2.id <> j.line_id
                 -- One of the team's AIs is only handed what was said to the team's assistant. What a client said to
                 -- an assistant they connected themselves is theirs, and the team does not read it.
                 and (j.subject is null or l2.by_table)
               order by l2.created_at desc limit 20) l), '[]'::jsonb));
$function$
;

-- What a client's page shows beside the conversation (so the client side does not feel empty; a client should
-- feel in control, without becoming a contributor): the team's faces, whether the team's AIs are on,
-- their own requests and where each stands, and the work under way they may hear of. Only that client's own things,
-- the same work titles their assistant may already tell them, never the team's talk.
create function public.client_overview(t uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := public.client_seat(t);
begin
  if me is null then
    raise exception 'that is not a table you are a client at';
  end if;
  return jsonb_build_object(
    'team', (select coalesce(jsonb_agg(jsonb_build_object('name', m.display_name, 'color', m.color, 'avatar', m.avatar, 'role', m.role,
               'ai_on', exists (select 1 from public.connections c where c.member_id = m.id and c.revoked_at is null and c.last_seen > now() - interval '90 seconds'))
               order by (m.role = 'owner') desc, m.created_at), '[]'::jsonb)
              from public.members m where m.table_id = t and m.role in ('owner', 'developer') and m.removed_at is null),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'status', r.status, 'at', r.updated_at) order by r.updated_at desc), '[]'::jsonb)
                  from (select * from public.requests r2 where r2.member_id = me order by r2.updated_at desc limit 30) r),
    'work', (select coalesce(jsonb_agg(jsonb_build_object('title', public.hide_secrets(left(w.title, 120)), 'status', w.status) order by w.created_at desc), '[]'::jsonb)
              from (select * from public.tasks t2 where t2.table_id = t and t2.status in ('working', 'done')
                       and (t2.reference ->> 'branch' = (select s.branch from public.sandboxes s where s.member_id = me)
                            or (t2.reference ->> 'client' is null
                                and not exists (select 1 from public.members o where o.table_id = t and o.role = 'client' and o.id <> me
                                                  and char_length(regexp_replace(split_part(btrim(o.display_name), ' ', 1), '[^[:alnum:]]', '', 'g')) > 1
                                                  and lower(' ' || regexp_replace(t2.title, '[^[:alnum:]]+', ' ', 'g') || ' ')
                                                      like '% ' || lower(regexp_replace(split_part(btrim(o.display_name), ' ', 1), '[^[:alnum:]]', '', 'g')) || ' %')))
                     order by t2.created_at desc limit 12) w));
end;
$$;
revoke all on function public.client_overview(uuid) from public, anon;
grant execute on function public.client_overview(uuid) to authenticated;

-- Every connection moves to 0.1.22, which asks the team's AIs when it must and stops when taken off every table.
update public.connect_release set version = '0.1.22', set_at = now();
