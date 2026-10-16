-- The access sweep (18 Oct 2026, his words: "should xyz be able to see or use or access abc" on everything).
--
-- Four reviews read every table, function, channel, storage rule, screen and job payload. Nothing let anyone in from
-- outside a table. What they found and this fixes:
-- * A question to clients with no request behind it was ONE row every client read: whoever answered first (the
--   owner's test client included) answered for all, and every client saw it. A decision may now only ask a client a
--   question about that client's own request, and a reply to anything else is refused.
-- * Deleting a client's account set their told-you rows to "about no request", which every client reads and hears.
--   Their told-you rows go with them now, and an undelivered decision about their request no longer reaches anyone.
-- * A client's assistant was told the titles of all the team's work, so one client could hear of another's. It no
--   longer hears of work whose title names another client at the table.
-- * Files shared from someone's computer kept reaching the other AIs after sharing was switched off or the sharer
--   was taken off the table.
-- * More key shapes are hidden (OpenAI project keys, Stripe, Resend, Slack, npm, Google).
-- * The operator page trusted the email in a sign-in without checking it was ever confirmed.
-- * Where a table's code lives, and a test change in a client's copy, are the owner's to set.
-- * Files uploaded straight to storage, never sent, are limited to ten at a time per person, and a person starts at
--   most ten tables a day, so nobody can fill the shared storage.
-- * A client sees the team and themselves at the table, never the other clients.
-- * Table rights nobody uses are taken away (writes happen inside these functions; the room's own chat message is
--   the one direct insert, held to its writer by its policy).

CREATE OR REPLACE FUNCTION public.create_decision(c uuid, title text, context text, origin text, affects_client boolean, options jsonb, request uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  t uuid;
  d uuid;
  me uuid;
  n int := jsonb_array_length(coalesce(options, '[]'::jsonb));
  tells boolean := coalesce(affects_client, false) or request is not null;
  i int;
  o jsonb;
  asking boolean;
  answers text[];
  questions int := 0;
begin
  -- The chat is held while the decision is made, so one deleted at that very moment refuses it in words.
  select ch.table_id into t from public.chats ch where ch.id = c for share;
  if t is null or not public.is_team(t) then
    raise exception 'only the team can ask for a decision';
  end if;
  if n < 2 or n > 4 then
    raise exception 'a decision needs two to four options';
  end if;
  if char_length(btrim(coalesce(title, ''))) not between 1 and 140 then
    raise exception 'a decision needs a title of up to 140 characters';
  end if;
  if request is not null and not exists (select 1 from public.requests r where r.id = request and r.table_id = t) then
    raise exception 'that request is not at this table';
  end if;
  me := public.my_member_id(t);
  insert into public.decisions (table_id, chat_id, title, context, origin, affects_client, created_by, request_id)
    values (t, c, btrim(title), btrim(coalesce(context, '')), btrim(coalesce(origin, '')), tells, me, request)
    returning id into d;
  for i in 0 .. n - 1 loop
    o := options -> i;
    asking := coalesce((o ->> 'asks_client')::boolean, false);
    answers := '{}';
    if asking then
      questions := questions + 1;
      if not tells then
        raise exception 'only a decision the client hears can ask them a question';
      end if;
      -- Answered once, by one client, for their own request: a question to "every client" would be one answer
      -- every client reads.
      if request is null then
        raise exception 'a question for the client has to be about one of their requests';
      end if;
      if btrim(coalesce(o ->> 'client_words', '')) = '' then
        raise exception 'write the question the client will be asked';
      end if;
      select coalesce(array_agg(btrim(x) order by ord), '{}') into answers
        from jsonb_array_elements_text(coalesce(o -> 'replies', '[]'::jsonb)) with ordinality as e(x, ord)
       where btrim(x) <> '';
      if cardinality(answers) not between 2 and 4 or exists (select 1 from unnest(answers) x where char_length(x) > 60) then
        raise exception 'a question for the client needs two to four short answers';
      end if;
      if (select count(distinct lower(x)) from unnest(answers) x) <> cardinality(answers) then
        raise exception 'the answers to a question must differ';
      end if;
    end if;
    insert into public.decision_options (decision_id, position, label, recommended, client_words, asks_client, replies)
      values (d, i + 1, btrim(o ->> 'label'), coalesce((o ->> 'recommended')::boolean, false),
              case when tells then btrim(coalesce(o ->> 'client_words', '')) else '' end, asking, answers);
  end loop;
  if questions > 1 then
    raise exception 'a decision can ask the client one question';
  end if;
  -- A new request, a follow-up on one already decided, or one the client has just answered goes back to being
  -- decided. One waiting on the client's answer, planned, ready to try or done keeps its status.
  if request is not null then
    update public.requests set status = 'being decided', updated_at = now()
     where id = request and status in ('asked', 'decided', 'answered');
    if found then
      perform public.add_request_event(request, 'The team is deciding');
    end if;
  end if;
  perform public.log_activity(t, me, 'decision.created', d, jsonb_build_object('title', btrim(title)));
  return d;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.client_reply(u uuid, choice integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  upd public.client_updates;
  me public.members;
  req public.requests;
  dec public.decisions;
  picked text;
  landing uuid;
begin
  select * into upd from public.client_updates where id = u for update;
  if not found then
    raise exception 'that question is not here';
  end if;
  select * into me from public.members where id = public.client_seat(upd.table_id);
  if not found or me.role <> 'client' then
    raise exception 'only the client answers here';
  end if;
  -- Only ever a question about this client's own request: an answer is never shared between clients.
  if upd.request_id is null then
    raise exception 'that question is not here';
  end if;
  select * into req from public.requests where id = upd.request_id;
  if req.member_id <> me.id then
    raise exception 'that question is not here';
  end if;
  if cardinality(upd.replies) = 0 then
    raise exception 'that is not a question';
  end if;
  if upd.answer is not null then
    raise exception 'already answered';
  end if;
  if choice is null or choice < 1 or choice > cardinality(upd.replies) then
    raise exception 'pick one of the answers';
  end if;
  picked := upd.replies[choice];
  update public.client_updates set answer = picked, answered_at = now(), answered_by = me.id where id = u;
  select * into dec from public.decisions where id = upd.decision_id;
  landing := coalesce(dec.chat_id,
    (select coalesce(tb.client_chat, (select ch.id from public.chats ch where ch.table_id = upd.table_id and ch.is_general))
       from public.tables tb where tb.id = upd.table_id));
  insert into public.messages (table_id, chat_id, member_id, body, kind, meta)
    values (upd.table_id, landing, me.id, picked, 'client',
            jsonb_build_object('request', upd.request_id, 'answers', upd.decision_id, 'question', upd.body));
  if req.id is not null then
    update public.requests set status = 'answered', updated_at = now() where id = req.id;
    perform public.add_request_event(req.id, 'You answered: ' || picked);
  end if;
  insert into public.client_updates (table_id, request_id, body)
    values (upd.table_id, upd.request_id, 'Thanks, passed on to the team.');
  perform public.log_activity(upd.table_id, me.id, 'client.answered', coalesce(req.id, upd.id), jsonb_build_object('answer', picked));
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
    'pages', public.pages_for_job(j),
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

CREATE OR REPLACE FUNCTION public.hide_secrets(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select regexp_replace(t,
    '(sk-ant-[A-Za-z0-9_-]{8,}|sb_secret_[A-Za-z0-9_-]{8,}|sb_publishable_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{32,}|[sr]k_(live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{35}|gh[ousr]_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,})',
    '[hidden]', 'g');
$function$
;

create or replace function public.is_operator()
returns boolean language sql stable security definer set search_path = '' as $$
  -- The address must be one this sign-in really confirmed, never just what the sign-in claims.
  select exists (select 1 from public.operators o join auth.users u on lower(u.email) = o.email
                  where u.id = auth.uid() and u.email_confirmed_at is not null
                    and o.email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

CREATE OR REPLACE FUNCTION public.set_table_repo(t uuid, url text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  clean text := btrim(coalesce(url, ''));
begin
  if not public.is_owner(t) then
    raise exception 'only the team can say where the code is';
  end if;
  if clean = '' then
    delete from public.table_code where table_id = t;
  else
    if clean !~ '^(https://|ssh://|git@)[A-Za-z0-9@:/._~+-]{4,250}$' then
      raise exception 'that does not look like a repository address; it starts with https:// or git@';
    end if;
    -- A sign-in written into the address (https://name:token@...) would be kept and shown to the team: refused.
    if clean ~ '^(https|ssh)://[^/]*@' then
      raise exception 'that address has a sign-in in it; give it without the name or token before the @';
    end if;
    insert into public.table_code (table_id, repo_url) values (t, clean)
      on conflict (table_id) do update set repo_url = excluded.repo_url, updated_at = now();
  end if;
  perform public.log_activity(t, public.my_member_id(t), 'table.repo_set', t, jsonb_build_object('set', clean <> ''));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.team_sandbox_change(m uuid, body text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  sb public.sandboxes;
  words text := btrim(coalesce(body, ''));
  seat uuid;
  change uuid;
begin
  select * into sb from public.sandboxes where member_id = m;
  if not found or not public.is_owner(sb.table_id) or not exists (select 1 from public.members x where x.id = m and x.removed_at is null) then
    raise exception 'that copy is not yours to try';
  end if;
  if char_length(words) = 0 or char_length(words) > 4000 then
    raise exception 'say what to change, in up to 4,000 characters';
  end if;
  if (select count(*) from public.sandbox_changes c where c.member_id = m and c.test and c.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'that is a lot of tests in one hour';
  end if;
  select cn.member_id into seat
    from public.connections cn join public.members mem on mem.id = cn.member_id and mem.role in ('owner', 'developer')
   where cn.table_id = sb.table_id and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
   order by (cn.member_id = public.my_member_id(sb.table_id)) desc, cn.created_at limit 1;
  if seat is null then
    raise exception 'connect your team''s Claude first';
  end if;
  insert into public.sandbox_changes (table_id, member_id, words, test) values (sb.table_id, m, words, true) returning id into change;
  insert into public.jobs (table_id, member_id, kind, change_id) values (sb.table_id, seat, 'sandbox', change);
  return change;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.start_table(table_name text, my_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  t uuid;
  me uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if (select count(*) from public.tables x where x.created_by = auth.uid() and x.created_at > now() - interval '1 day') >= 10 then
    raise exception 'that is ten new tables today; try again tomorrow';
  end if;
  insert into public.tables (name, created_by) values (btrim(table_name), auth.uid()) returning id into t;
  insert into public.members (table_id, user_id, role, display_name, color)
    values (t, auth.uid(), 'owner', btrim(my_name), public.next_color(t)) returning id into me;
  insert into public.chats (table_id, name, about, is_general, created_by) values (t, 'General', 'Everyone on the team', true, me);
  perform public.log_activity(t, me, 'table.started', t, jsonb_build_object('name', btrim(table_name)));
  return t;
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
  req := public.pass_on_request(coalesce(j.subject, j.member_id), line.body, null, line.id, false);
  insert into public.client_lines (table_id, member_id, who, body, request_id, by_table)
    values (j.table_id, coalesce(j.subject, j.member_id), 'assistant', 'Passed on to the team, since I could not answer that just now. You will hear here what they decide.', req, j.subject is not null);
end;
$function$
;


-- When a client's account is deleted, what they were told goes with them, never to every client.
create function public.forget_client_told()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'client' then
    delete from public.client_updates u using public.requests r where r.id = u.request_id and r.member_id = old.id;
    update public.decisions d set affects_client = false
      from public.requests r where r.id = d.request_id and r.member_id = old.id and d.delivered_at is null;
  end if;
  return old;
end;
$$;
revoke all on function public.forget_client_told() from public, anon, authenticated;
create trigger members_forget_client_told before delete on public.members
  for each row execute function public.forget_client_told();

-- A client sees the team and themselves; another client is not theirs to see.
drop policy "members read the people at their tables" on public.members;
create policy "members read the people at their tables" on public.members for select
  using (public.is_team(table_id)
         or (public.is_member(table_id) and (role in ('owner', 'developer') or user_id = auth.uid())));

-- Files sent straight to storage and never put in a message: ten at a time per person.
create function public.my_loose_uploads()
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::integer from storage.objects o
   where o.bucket_id = 'attachments' and o.owner_id = auth.uid()::text
     and not exists (select 1 from public.attachments a where a.path = o.name);
$$;
revoke all on function public.my_loose_uploads() from public, anon;
grant execute on function public.my_loose_uploads() to authenticated;
drop policy if exists "attach in your own folder" on storage.objects;
create policy "attach in your own folder" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.my_member_id(((storage.foldername(name))[1])::uuid)::text = (storage.foldername(name))[2]
    and public.my_loose_uploads() < 10);

-- Rights nobody uses: every write happens inside the functions above, never straight to a table.
revoke insert, update, delete, truncate, trigger, references on public.activity, public.chats, public.client_lines,
  public.client_updates, public.decision_options, public.decisions, public.invites, public.members, public.messages,
  public.notes, public.pairings, public.request_events, public.requests, public.tables from anon, authenticated;
-- The one direct write the screens make: a team member's own chat message, which its policy holds to themselves.
grant insert on public.messages to authenticated;
revoke all on public.attachments, public.attachment_links, public.round_materials from anon;
revoke all on function public.next_color(uuid) from public, anon, authenticated;
