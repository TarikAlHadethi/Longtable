-- A chat no AI hears ("No AI"). Until now a room could only stop the AIs answering; they still read it, and with
-- notes off the setup window saved "when needed" whatever was picked. Now:
-- * chats.answers takes 'off'. Every message written there is marked no_ai, and the mark can never be taken off, so
--   nothing said while the room was off reaches an AI even if the room is changed back.
-- * Every place an AI reads messages (its chat's history, related messages from other chats, messages handed to a
--   running job) leaves no_ai messages out; such a room is never heard, never noted, and asking there only says.
-- * A guard refuses any AI job for such a room, whatever path tries to make one.
-- * General cannot be off, and a room that is off never takes clients' requests.
-- Old connections keep working: nothing they call changes shape.

alter table public.chats drop constraint if exists chats_answers_check;
alter table public.chats add constraint chats_answers_check check (answers in ('normal', 'named', 'silent', 'off'));

alter table public.messages add column if not exists no_ai boolean not null default false;

create or replace function public.message_no_ai() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.no_ai := old.no_ai or new.no_ai;
    return new;
  end if;
  new.no_ai := new.no_ai or exists (select 1 from public.chats ch where ch.id = new.chat_id and ch.answers = 'off');
  return new;
end;
$$;
drop trigger if exists messages_no_ai on public.messages;
create trigger messages_no_ai before insert or update on public.messages for each row execute function public.message_no_ai();

create or replace function public.jobs_never_in_no_ai_room() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.chats ch where ch.id = new.chat_id and ch.answers = 'off')
     or exists (select 1 from public.messages m where m.id = new.question_id and m.no_ai) then
    raise exception 'tripwire: no AI hears this chat';
  end if;
  return new;
end;
$$;
drop trigger if exists jobs_never_in_no_ai_room on public.jobs;
create trigger jobs_never_in_no_ai_room before insert on public.jobs for each row execute function public.jobs_never_in_no_ai_room();

create or replace function public.client_chat_hears() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.client_chat is not null and exists (select 1 from public.chats ch where ch.id = new.client_chat and ch.answers = 'off') then
    raise exception 'clients'' requests cannot go to a chat no AI hears';
  end if;
  return new;
end;
$$;
drop trigger if exists tables_client_chat_hears on public.tables;
create trigger tables_client_chat_hears before insert or update of client_chat on public.tables for each row execute function public.client_chat_hears();

revoke all on function public.message_no_ai() from public, anon, authenticated;
revoke all on function public.jobs_never_in_no_ai_room() from public, anon, authenticated;
revoke all on function public.client_chat_hears() from public, anon, authenticated;

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

CREATE OR REPLACE FUNCTION public.runner_inbox(token text, job uuid, open boolean DEFAULT true, seen uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
  q public.messages;
  got jsonb;
  back timestamptz;
begin
  select * into j from public.jobs where id = job and member_id = c.member_id for update;
  if not found then
    raise exception 'that job is not this connection''s';
  end if;
  if not coalesce(open, true) then
    update public.jobs set taking = false where id = job;
    update public.delivered_messages set confirmed = true where job_id = job and message_id = any(coalesce(seen, '{}'::uuid[]));
    select min(m.created_at) into back from public.messages m
      join public.delivered_messages d on d.message_id = m.id and d.job_id = job and not d.confirmed;
    delete from public.delivered_messages where job_id = job and not confirmed;
    if back is not null then
      insert into public.listens (chat_id, table_id, since, due_at) values (j.chat_id, j.table_id, back, now() + interval '4 seconds')
        on conflict (chat_id) do update set since = least(public.listens.since, excluded.since), due_at = least(public.listens.due_at, excluded.due_at);
    end if;
    return '[]'::jsonb;
  end if;
  select * into q from public.messages where id = j.question_id;
  -- Only a run of the person's own request, while it runs.
  if j.status <> 'running' or q.id is null or q.member_id <> c.member_id then
    return '[]'::jsonb;
  end if;
  if not j.taking then
    -- A new attempt at this job (its connection restarted): what an earlier attempt was handed but never read is
    -- handed over again.
    delete from public.delivered_messages where job_id = job and not confirmed;
    update public.jobs set taking = true where id = job;
  end if;
  with fresh as (
    select m.id, m.body, m.created_at, m.meta -> 'pasted' as pasted from public.messages m
     where m.chat_id = j.chat_id and m.member_id = c.member_id and m.kind = 'chat' and not m.by_ai and not m.no_ai
       and m.created_at > q.created_at and m.id <> q.id
       -- Not one that is a request of its own (asked outright, or already heard), not a command, not one with files:
       -- those go to the table as usual.
       and not exists (select 1 from public.jobs jj where jj.question_id = m.id)
       and m.body !~ '^\s*/[A-Za-z]'
       and not exists (select 1 from public.attachments a where a.message_id = m.id)
       and not exists (select 1 from public.delivered_messages d where d.message_id = m.id)
     order by m.created_at limit 20
  ), kept as (
    insert into public.delivered_messages (message_id, job_id) select id, job from fresh on conflict do nothing returning message_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'body', f.body, 'at', f.created_at, 'pasted', f.pasted) order by f.created_at), '[]'::jsonb)
    into got from fresh f where f.id in (select message_id from kept);
  return got;
end;
$function$;

CREATE OR REPLACE FUNCTION public.hear_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.by_ai or new.no_ai or new.kind <> 'chat' or coalesce(current_setting('longtable.asked', true), '') = '1' then
    return null;
  end if;
  if public.final_seat_now(new.table_id) is null then
    return null;
  end if;
  if exists (select 1 from public.chats ch where ch.id = new.chat_id and (not ch.set_up or ch.answers in ('silent', 'off'))) then
    return null;
  end if;
  insert into public.listens (chat_id, table_id, since, due_at)
    values (new.chat_id, new.table_id, new.created_at, now() + interval '1.5 seconds')
    on conflict (chat_id) do update set due_at = excluded.due_at, since = least(public.listens.since, excluded.since);
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notes_now()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ch public.chats;
  seat uuid;
  n integer := 0;
begin
  update public.jobs set status = 'skipped', lease_until = null, error = 'nobody picked it up'
   where kind = 'notes' and ((status = 'queued' and created_at < now() - interval '10 minutes')
                          or (status = 'running' and lease_until < now() - interval '2 minutes'));
  for ch in select * from public.chats c where c.notes and c.set_up and c.answers <> 'off' loop
    continue when exists (select 1 from public.jobs j where j.chat_id = ch.id and j.kind = 'notes' and j.status in ('queued', 'running'));
    continue when not exists (select 1 from public.messages m where m.chat_id = ch.id and m.kind in ('chat', 'answer')
                                and m.created_at > coalesce(ch.noted_at, '-infinity'::timestamptz));
    continue when (select max(m.created_at) from public.messages m where m.chat_id = ch.id) > now() - interval '60 seconds'
              and (select count(*) from public.messages m where m.chat_id = ch.id and m.kind in ('chat', 'answer')
                     and m.created_at > coalesce(ch.noted_at, '-infinity'::timestamptz)) < 15;
    select cn.member_id into seat
      from public.connections cn join public.members mem on mem.id = cn.member_id and mem.role in ('owner', 'developer') and mem.removed_at is null
     where cn.table_id = ch.table_id and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
       and public.member_sees_chat(ch.id, cn.member_id)
     order by (cn.member_id = ch.created_by) desc, cn.created_at
     limit 1;
    continue when seat is null;
    insert into public.jobs (table_id, chat_id, member_id, kind) values (ch.table_id, ch.id, seat, 'notes');
    n := n + 1;
  end loop;
  return n;
end;
$function$;

CREATE OR REPLACE FUNCTION public.setup_chat(c uuid, chat_name text, chat_about text, who text, people uuid[], take_notes boolean, ai_answers text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ch public.chats;
  me uuid;
  clean text := left(btrim(coalesce(chat_name, '')), 60);
begin
  select * into ch from public.chats where id = c for update;
  if not found or not public.can_see_chat(c) then
    raise exception 'that chat is not at a table you are on';
  end if;
  me := public.my_member_id(ch.table_id);
  if not (coalesce(ch.created_by = me, false) or public.is_owner(ch.table_id)) then
    raise exception 'only the person who made this chat, or an owner, can set it up';
  end if;
  if ch.is_general and who <> 'everyone' then
    raise exception 'General is everyone''s';
  end if;
  if char_length(clean) = 0 then
    raise exception 'a chat needs a name';
  end if;
  if char_length(btrim(coalesce(chat_about, ''))) > 140 then
    raise exception 'what a chat is for takes up to 140 characters';
  end if;
  if who not in ('everyone', 'some', 'me') then
    raise exception 'a chat is for everyone, some people, or just you';
  end if;
  if coalesce(ai_answers, '') not in ('normal', 'named', 'silent', 'off') then
    raise exception 'the AIs answer normally, when named, never, or no AI hears the chat';
  end if;
  if ai_answers = 'off' and ch.is_general then
    raise exception 'General is where the AIs work; make a new chat for talk no AI may hear';
  end if;
  if who = 'some' and exists (select 1 from unnest(coalesce(people, '{}')) p
                               where not exists (select 1 from public.members m where m.id = p and m.table_id = ch.table_id
                                                   and m.role in ('owner', 'developer') and m.removed_at is null)) then
    raise exception 'only people on the team can be in a chat';
  end if;
  update public.chats set name = clean, about = btrim(coalesce(chat_about, '')), private = who <> 'everyone',
         notes = coalesce(take_notes, false) and ai_answers <> 'off', answers = ai_answers, set_up = true,
         created_by = coalesce(created_by, me)
   where id = c;
  delete from public.chat_people where chat_id = c;
  if who <> 'everyone' then
    insert into public.chat_people (chat_id, member_id)
      select c, x from (select me as x union select ch.created_by where ch.created_by is not null
                          and exists (select 1 from public.members mm where mm.id = ch.created_by and mm.removed_at is null)
                        union select unnest(coalesce(people, '{}')) where who = 'some') s on conflict do nothing;
    -- Open work of someone now outside the room: views and reviews are dropped, anything else goes to someone inside.
    update public.jobs set status = 'skipped', lease_until = null, error = 'not in the room any more'
     where chat_id = c and status in ('queued', 'running', 'waiting') and kind in ('view', 'review') and not public.member_sees_chat(c, member_id);
    update public.jobs set member_id = member_id
     where chat_id = c and status in ('queued', 'waiting') and not public.member_sees_chat(c, member_id);
    update public.jobs set status = 'skipped', lease_until = null, error = 'not in the room any more'
     where chat_id = c and status in ('queued', 'running', 'waiting') and not public.member_sees_chat(c, member_id);
  end if;
  if ai_answers = 'off' then
    -- Everything already said here is kept from the AIs for good, and any work they had in it ends now.
    update public.messages set no_ai = true where chat_id = c and not no_ai;
    update public.jobs set status = 'skipped', lease_until = null, error = 'no AI hears this chat'
     where chat_id = c and status in ('queued', 'running', 'waiting');
    delete from public.listens where chat_id = c;
    update public.tables set client_chat = null where id = ch.table_id and client_chat = c;
  end if;
  -- Nobody may be left reading a room from the requests side: a private chat never takes clients' requests.
  update public.tables set client_chat = null where id = ch.table_id and client_chat = c and who <> 'everyone';
  if coalesce(current_setting('longtable.making_chat', true), '') <> '1' then
    perform public.log_activity(ch.table_id, me, 'chat.set_up', c, jsonb_build_object('name', clean));
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.ask_table(c uuid, body text, files jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  t uuid;
  me uuid;
  q uuid;
  words text := btrim(coalesce(body, ''));
  got jsonb;
begin
  select ch.table_id into t from public.chats ch where ch.id = c;
  if t is null or not public.can_see_chat(c) or not (select ch.set_up from public.chats ch where ch.id = c) then
    raise exception 'only the team can ask the table';
  end if;
  me := public.my_member_id(t);
  if char_length(words) = 0 and coalesce(jsonb_array_length(files), 0) = 0 then
    raise exception 'ask something';
  end if;
  if char_length(words) > 8000 then
    raise exception 'that is a lot for one message; keep it to 8,000 characters or fewer';
  end if;
  -- A message that is only attachments still needs words to be found by: their names.
  if char_length(words) = 0 then
    words := left((select string_agg(f ->> 'name', ', ') from jsonb_array_elements(files) f), 500);
  end if;
  perform set_config('longtable.asked', '1', true);
  insert into public.messages (table_id, chat_id, member_id, body) values (t, c, me, words) returning id into q;
  if coalesce(jsonb_array_length(files), 0) > 0 then
    got := public.take_files(t, me, files, q);
    update public.messages set meta = meta || jsonb_build_object('files', got) where id = q;
  end if;
  -- In a chat no AI hears, asking is only saying.
  if (select ch.answers from public.chats ch where ch.id = c) = 'off' then
    return jsonb_build_object('message_id', q, 'answered_by', null);
  end if;
  return public.start_round(t, c, q, me);
end;
$function$;
