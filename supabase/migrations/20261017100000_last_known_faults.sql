-- The last known faults from the bug sweep's list (17 Oct 2026).
--
-- D12: a listen job held a five-minute lease, and a failed listen was tried again like any other job. A listener whose
-- computer stopped mid-job held up hearing in its chat for about six minutes. Now a listen holds 90 seconds and is
-- never tried again (the design always said so), and a look starts with two minutes, its heartbeats keeping it.
-- D13: a client's question answered by the team's assistant was announced on a channel named after the team member
-- whose AI was answering, so the client's page never heard live that it was being answered. It now goes to that
-- client's own channel, carrying only what their page needs: which job, its kind and its state.
-- D14: a plan handing work to "Sam" matched anyone whose name starts with Sam, through LIKE (where a name holding
-- % or _ also matched others), and took whichever came first. Now a full name is matched exactly; a first name only
-- when exactly one person on the table has it; otherwise the part stays with the lead, never with a guess.

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
    return public.client_job_payload(j);
  end if;
  if j.kind = 'sandbox' then
    return public.sandbox_job_payload(j);
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
     where m.table_id = j.table_id and m.kind = 'view' and m.meta ->> 'round' = j.round::text;
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
    -- Whether the one asking is this connection's own person, and has left on that their AI may open places on
    -- their own computer that they point at. Never true for anyone else's message.
    'own_paths', coalesce(q.member_id = c.member_id and c.open_paths, false),
    -- Whether what they point at may also be handed to the other AIs working on the same request.
    'share_paths', coalesce(q.member_id = c.member_id and c.open_paths and c.share_paths, false),
    -- What another person's AI read from their own computer and shared for this request. Never this AI's own.
    'materials', (select coalesce(jsonb_agg(jsonb_build_object('from', mem.display_name, 'name', rm.name, 'body', rm.body) order by rm.created_at), '[]'::jsonb)
                    from public.round_materials rm join public.members mem on mem.id = rm.member_id
                   where rm.question_id = q.id and rm.member_id <> c.member_id),
    -- What was attached to the message being answered, and to the few before it in the same chat.
    'attachments', (select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb) from (
                      select a.id, a.name, a.mime, a.size, a.kind, a.path, l.url, a.created_at, mem.display_name as "from"
                        from public.attachments a join public.attachment_links l on l.attachment_id = a.id
                        join public.messages am on am.id = a.message_id join public.members mem on mem.id = a.member_id
                       where am.chat_id = j.chat_id and am.created_at <= q.created_at and am.created_at > q.created_at - interval '2 hours'
                       order by a.created_at desc limit 8) x),
    -- A message that starts with "/" runs one of the asker's own AI's commands. Its name and what it is for.
    'command', (select jsonb_build_object('name', cmd ->> 'name', 'about', cmd ->> 'about', 'mine', q.member_id = c.member_id)
                  from public.connections ac, jsonb_array_elements(ac.commands) cmd
                 where ac.member_id = q.member_id and ac.revoked_at is null
                   and q.body ~ '^\s*/' and lower(cmd ->> 'name') = lower(substring(q.body from '^\s*/([A-Za-z0-9:_-]+)'))
                 order by ac.last_seen desc nulls last limit 1),
    'question', q.body,
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
                and cn.last_seen > now() - interval '60 seconds' and cn.member_id <> c.member_id),
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
                 order by tk.created_at desc limit 8) x),
    'worker', (select mem.display_name from public.jobs w join public.members mem on mem.id = w.member_id where w.round = j.round and w.kind = 'work' limit 1),
    'work_read', (select m.meta ->> 'read' from public.jobs w join public.messages m on m.id = w.result_message_id
                   where w.round = j.round and w.kind = 'work' and w.status = 'done' and coalesce((w.outcome ->> 'changed')::boolean, false)
                   order by w.stage desc limit 1),
    'related', related,
    'pinned', pinned);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.runner_fail(token text, job uuid, reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
  rnd uuid;
begin
  select round into rnd from public.jobs where id = job;
  if rnd is not null then
    perform pg_advisory_xact_lock(hashtext(rnd::text));
  end if;
  select * into j from public.jobs where id = job for update;
  if not found or j.member_id <> c.member_id or j.status <> 'running' then
    raise exception 'this job is not yours';
  end if;
  if j.kind = 'client' then
    perform public.give_up_client_job(j.id, reason);
    return;
  end if;
  update public.jobs
     set status = case when j.attempts >= 3 or j.kind = 'listen' then 'failed'::public.job_status else 'queued'::public.job_status end,
         error = public.hide_secrets(left(coalesce(reason, ''), 500)), lease_until = null,
         created_at = case when j.attempts >= 3 or j.kind = 'listen' then created_at else now() end
   where id = j.id;
  if j.round is not null then
    perform public.advance_round(j.round);
  end if;
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
    perform realtime.send(jsonb_build_object('table', 'jobs', 'record', jsonb_build_object('id', new.id, 'kind', new.kind, 'status', new.status, 'member_id', new.subject, 'created_at', new.created_at)),
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
