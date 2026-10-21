-- Chat rooms: a chat can be set up as private (everyone, some people, or just its maker), with an AI that takes notes
-- and a choice of how the AIs answer. Every table gets a second room, "Chat room", that its owner sets up. Who can
-- see a private chat is enforced here: reading it, writing in it, its live updates, the activity log, the owner's
-- download, and every AI job, which only ever goes to the AI of someone in the room.

alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check
  check (kind in ('answer', 'view', 'combine', 'intro', 'client', 'work', 'review', 'listen', 'look', 'plan', 'sandbox', 'notes'));

alter table public.chats
  add column private boolean not null default false,
  add column notes boolean not null default false,
  add column answers text not null default 'normal' check (answers in ('normal', 'named', 'silent')),
  add column set_up boolean not null default true,
  add column notes_page uuid references public.pages(id) on delete set null,
  add column noted_at timestamptz;

-- Who is in a private chat. Its maker is always in it.
create table public.chat_people (
  chat_id uuid not null references public.chats(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  primary key (chat_id, member_id)
);
alter table public.chat_people enable row level security;
grant select on public.chat_people to authenticated;

-- Whether a person (by member id) is in a chat: every chat but a private one is everyone's at the table.
create function public.member_sees_chat(c uuid, m uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chats ch join public.members mem on mem.id = m and mem.table_id = ch.table_id and mem.removed_at is null
                  where ch.id = c and (not ch.private or exists (select 1 from public.chat_people p where p.chat_id = c and p.member_id = m)));
$$;
-- The same, for whoever is signed in: on the team, and in the room when it is private.
create function public.can_see_chat(c uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chats ch
                  where ch.id = c and public.is_team(ch.table_id)
                    and (not ch.private or exists (select 1 from public.chat_people p where p.chat_id = c and p.member_id = public.my_member_id(ch.table_id))));
$$;
create function public.chat_is_private(c uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select ch.private from public.chats ch where ch.id = c), false);
$$;
-- Where a chat's live changes go: the team's channel, or the room's own for a private chat.
create function public.chat_topic(t uuid, c uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when c is not null and public.chat_is_private(c) then 'room:' || c::text else 'team:' || t::text end;
$$;
create function public.room_topic_chat_id(topic text)
returns uuid language sql immutable set search_path = '' as $$
  select case when topic ~ '^room:[0-9a-f-]{36}$' then substring(topic from 6)::uuid else null end;
$$;
-- A line of the log about something in a chat is seen only by whoever can see that chat.
create function public.subject_visible(s uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select public.can_see_chat(x.c) from (
           select ch.id as c from public.chats ch where ch.id = s
           union all select m.chat_id from public.messages m where m.id = s
           union all select d.chat_id from public.decisions d where d.id = s
           union all select tk.chat_id from public.tasks tk where tk.id = s
           union all select pg.chat_id from public.pages pg where pg.id = s
           union all select j.chat_id from public.jobs j where j.id = s and j.chat_id is not null) x limit 1), true);
$$;
revoke all on function public.member_sees_chat(uuid, uuid) from public, anon, authenticated;
revoke all on function public.chat_topic(uuid, uuid) from public, anon, authenticated;
revoke all on function public.subject_visible(uuid) from public, anon;
revoke all on function public.can_see_chat(uuid) from public, anon;
revoke all on function public.chat_is_private(uuid) from public, anon, authenticated;

create policy "the room's people see who is in it" on public.chat_people for select using (public.can_see_chat(chat_id));

-- Reading: a private chat and everything in it only for the people in it.
drop policy "the team reads its chats" on public.chats;
create policy "the team reads its chats, a private one only its people" on public.chats for select using (public.can_see_chat(id));
drop policy "the team reads its messages" on public.messages;
create policy "the team reads its messages, a private chat's only its people" on public.messages for select using (public.can_see_chat(chat_id));
drop policy "the team writes messages as itself" on public.messages;
create policy "the team writes messages as itself, where it may" on public.messages for insert with check (
  public.is_team(table_id) and member_id = public.my_member_id(table_id) and not by_ai and kind = 'chat' and meta = '{}'::jsonb
  and public.can_see_chat(chat_id) and coalesce((select ch.set_up from public.chats ch where ch.id = chat_id), false));
drop policy "the team reads its decisions" on public.decisions;
create policy "the team reads its decisions, a private chat's only its people" on public.decisions for select using (public.can_see_chat(chat_id));
drop policy "the team sees its tasks" on public.tasks;
create policy "the team sees its tasks, a private chat's only its people" on public.tasks for select using (public.can_see_chat(chat_id));
drop policy "the team sees its pages" on public.pages;
create policy "the team sees its pages, a private chat's only its people" on public.pages for select using (public.can_see_chat(chat_id));
drop policy "the team sees its page versions" on public.page_versions;
create policy "the team sees its page versions, a private chat's only its people" on public.page_versions for select
  using (exists (select 1 from public.pages p where p.id = page_id and public.can_see_chat(p.chat_id)));
drop policy "the team sees its page comments" on public.page_comments;
create policy "the team sees its page comments, a private chat's only its people" on public.page_comments for select
  using (exists (select 1 from public.pages p where p.id = page_id and public.can_see_chat(p.chat_id)));
drop policy "the team sees its pages' state" on public.page_state;
create policy "the team sees its pages' state, a private chat's only its people" on public.page_state for select
  using (exists (select 1 from public.pages p where p.id = page_id and public.can_see_chat(p.chat_id)));
drop policy "the team sees the team's jobs, and each person their own" on public.jobs;
create policy "the team sees the team's jobs, a private chat's only its people, and each person their own" on public.jobs for select
  using ((public.is_team(table_id) and kind <> 'client' and (chat_id is null or public.can_see_chat(chat_id))) or member_id = public.my_member_id(table_id));
drop policy "the team sees what is attached at its table" on public.attachments;
create policy "the team sees what is attached at its table, in a private chat only its people" on public.attachments for select
  using (public.is_team(table_id)
         and (message_id is null or exists (select 1 from public.messages m where m.id = message_id and public.can_see_chat(m.chat_id)))
         and (job_id is null or exists (select 1 from public.jobs j where j.id = job_id and (j.chat_id is null or public.can_see_chat(j.chat_id)))));
-- The files themselves: your own folder, or a file whose attachment row you may see (so a private room's files stay
-- its people's). Before this, anyone on the team could list and download every folder of the table.
-- Whether a file belongs to a private room the signed-in person is not in (read past the attachments' own rules, which
-- would hide exactly those rows).
create function public.file_in_hidden_room(path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.attachments a left join public.messages m on m.id = a.message_id left join public.jobs j on j.id = a.job_id
                  where a.path = file_in_hidden_room.path
                    and ((m.chat_id is not null and not public.can_see_chat(m.chat_id)) or (j.chat_id is not null and not public.can_see_chat(j.chat_id))));
$$;
revoke all on function public.file_in_hidden_room(text) from public, anon;
drop policy "the team reads its table's attachments" on storage.objects;
-- Your own folder; a file whose attachment you may see; and for an owner every file of the table (deleting the table
-- removes them all) except a private room's they are not in.
create policy "the team reads its table's attachments, a private room's only its people" on storage.objects for select
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
         and ((public.my_member_id(((storage.foldername(name))[1])::uuid))::text = (storage.foldername(name))[2]
              or exists (select 1 from public.attachments a where a.path = storage.objects.name)
              or (public.is_owner(((storage.foldername(name))[1])::uuid) and not public.file_in_hidden_room(storage.objects.name))));

do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'activity' and cmd = 'SELECT' and qual like '%is_team%' loop
    execute format('drop policy %I on public.activity', pol.policyname);
  end loop;
end $$;
alter table public.activity add column chat_id uuid;
-- Which chat a line of the log is about, worked out when it is written (its subject still exists then).
create function public.activity_chat()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.chat_id is null and new.subject is not null then
    new.chat_id := case when new.action like 'chat.%' then new.subject else (select x.c from (
             select m.chat_id as c from public.messages m where m.id = new.subject
             union all select d.chat_id from public.decisions d where d.id = new.subject
             union all select tk.chat_id from public.tasks tk where tk.id = new.subject
             union all select pg.chat_id from public.pages pg where pg.id = new.subject
             union all select j.chat_id from public.jobs j where j.id = new.subject) x where x.c is not null limit 1) end;
  end if;
  return new;
end;
$$;
create trigger activity_chat before insert on public.activity for each row execute function public.activity_chat();
-- The log is append-only; filling the new column for lines already written is the one change it takes.
do $$ begin
  perform set_config('longtable.deleting_table', '1', true);
  update public.activity a set chat_id = case when a.action like 'chat.%' then a.subject else (select x.c from (
           select m.chat_id as c from public.messages m where m.id = a.subject
           union all select d.chat_id from public.decisions d where d.id = a.subject
           union all select tk.chat_id from public.tasks tk where tk.id = a.subject
           union all select pg.chat_id from public.pages pg where pg.id = a.subject
           union all select j.chat_id from public.jobs j where j.id = a.subject) x where x.c is not null limit 1) end
   where a.subject is not null;
  perform set_config('longtable.deleting_table', '', true);
end $$;
-- A private chat that was deleted, so its lines in the log stay hidden. A plain id: deleting a whole table deletes
-- its chats in the same moment, and the log goes with the table anyway.
create table public.gone_private_chats (chat_id uuid primary key, table_id uuid not null);
alter table public.gone_private_chats enable row level security;
-- A line about a chat is seen by whoever can see that chat; one about a chat that is gone, only if it was not private.
create function public.log_line_visible(t uuid, c uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select c is null or public.can_see_chat(c)
         or (not exists (select 1 from public.chats ch where ch.id = c) and not exists (select 1 from public.gone_private_chats g where g.chat_id = c));
$$;
create function public.remember_gone_private()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.private then
    insert into public.gone_private_chats (chat_id, table_id) values (old.id, old.table_id) on conflict do nothing;
  end if;
  return old;
end;
$$;
create trigger remember_gone_private before delete on public.chats for each row execute function public.remember_gone_private();
create policy "the team reads its log, a private chat's lines only its people" on public.activity for select
  using (public.is_team(table_id) and public.log_line_visible(table_id, chat_id));

-- A private room's live channel: only its people hear it, nobody sends on it.
create policy "a room's people hear its channel" on realtime.messages for select to authenticated
  using (public.can_see_chat(public.room_topic_chat_id(realtime.topic())));

-- Every AI job stays inside its room: a job meant for someone not in a private chat goes to someone who is (the
-- one who asked, else whoever in the room has their AI on), and a view or review from outside is never asked.
create function public.jobs_stay_in_room()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  asker uuid;
  inside uuid;
begin
  if new.chat_id is null or not public.chat_is_private(new.chat_id) or public.member_sees_chat(new.chat_id, new.member_id) then
    return new;
  end if;
  if new.kind in ('view', 'review') then
    return null;
  end if;
  select m.member_id into asker from public.messages m where m.id = new.question_id;
  select cn.member_id into inside
    from public.connections cn join public.members mem on mem.id = cn.member_id and mem.role in ('owner', 'developer') and mem.removed_at is null
   where cn.table_id = new.table_id and cn.revoked_at is null and public.member_sees_chat(new.chat_id, cn.member_id)
     and (new.kind not in ('work', 'plan', 'notes') or cn.kind = 'claude')
   order by (cn.member_id = asker) desc, (cn.last_seen > now() - interval '60 seconds') desc, cn.last_seen desc nulls last
   limit 1;
  new.member_id := coalesce(inside, case when public.member_sees_chat(new.chat_id, asker) then asker end,
                            (select ch.created_by from public.chats ch where ch.id = new.chat_id));
  if new.member_id is null or not public.member_sees_chat(new.chat_id, new.member_id) then
    return null;
  end if;
  return new;
end;
$$;
create trigger jobs_stay_in_room before insert or update of member_id on public.jobs
  for each row execute function public.jobs_stay_in_room();

-- Live changes of things that live in a chat go where the chat's people hear them.
create function public.broadcast_chat_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  c uuid;
  t uuid;
begin
  if tg_op = 'DELETE' then
    return null;
  end if;
  t := new.table_id;
  if tg_table_name = 'chats' then
    c := new.id;
    -- Everyone hears that a private chat changed, never its name or what it is about: their screens read the list
    -- again and see it only if they are in it.
    if new.private or (tg_op = 'UPDATE' and old.private) then
      perform realtime.send(jsonb_build_object('table', 'chats', 'record', jsonb_build_object('id', new.id, 'table_id', t, 'private', true)),
        tg_op, 'team:' || t::text, true);
      if new.private then
        perform realtime.broadcast_changes('room:' || c::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
      end if;
      return null;
    end if;
  elsif tg_table_name in ('page_comments', 'page_state') then
    select p.chat_id into c from public.pages p where p.id = new.page_id;
  else
    c := new.chat_id;
  end if;
  perform realtime.broadcast_changes(public.chat_topic(t, c), tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
  return null;
end;
$$;

do $$
declare tr record;
begin
  for tr in select distinct trigger_name from information_schema.triggers
             where event_object_schema = 'public' and event_object_table = 'chats' and action_statement ilike '%broadcast_team_change%' loop
    execute format('create or replace trigger %I after insert or update on public.chats for each row execute function public.broadcast_chat_change()', tr.trigger_name);
  end loop;
end $$;

do $$
declare tr record;
begin
  for tr in select distinct trigger_name from information_schema.triggers
             where event_object_schema = 'public' and event_object_table = 'decisions' and action_statement ilike '%broadcast_team_change%' loop
    execute format('create or replace trigger %I after insert or update on public.decisions for each row execute function public.broadcast_chat_change()', tr.trigger_name);
  end loop;
end $$;

do $$
declare tr record;
begin
  for tr in select distinct trigger_name from information_schema.triggers
             where event_object_schema = 'public' and event_object_table = 'tasks' and action_statement ilike '%broadcast_team_change%' loop
    execute format('create or replace trigger %I after insert or update on public.tasks for each row execute function public.broadcast_chat_change()', tr.trigger_name);
  end loop;
end $$;

do $$
declare tr record;
begin
  for tr in select distinct trigger_name from information_schema.triggers
             where event_object_schema = 'public' and event_object_table = 'pages' and action_statement ilike '%broadcast_team_change%' loop
    execute format('create or replace trigger %I after insert or update on public.pages for each row execute function public.broadcast_chat_change()', tr.trigger_name);
  end loop;
end $$;

do $$
declare tr record;
begin
  for tr in select distinct trigger_name from information_schema.triggers
             where event_object_schema = 'public' and event_object_table = 'page_comments' and action_statement ilike '%broadcast_team_change%' loop
    execute format('create or replace trigger %I after insert or update on public.page_comments for each row execute function public.broadcast_chat_change()', tr.trigger_name);
  end loop;
end $$;

do $$
declare tr record;
begin
  for tr in select distinct trigger_name from information_schema.triggers
             where event_object_schema = 'public' and event_object_table = 'page_state' and action_statement ilike '%broadcast_team_change%' loop
    execute format('create or replace trigger %I after insert or update on public.page_state for each row execute function public.broadcast_chat_change()', tr.trigger_name);
  end loop;
end $$;

CREATE OR REPLACE FUNCTION public.broadcast_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform realtime.broadcast_changes(public.chat_topic(new.table_id, new.chat_id), tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
  return null;
end;
$function$;

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
    perform realtime.broadcast_changes(public.chat_topic(new.table_id, new.chat_id), tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.broadcast_page_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform realtime.send(jsonb_build_object('table', 'page_versions', 'record', jsonb_build_object('id', new.id, 'page_id', new.page_id,
    'table_id', new.table_id, 'n', new.n, 'made_by', new.made_by, 'by_ai', new.by_ai, 'note', new.note, 'created_at', new.created_at)),
    'INSERT', public.chat_topic(new.table_id, (select p.chat_id from public.pages p where p.id = new.page_id)), true);
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.broadcast_page_gone()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform realtime.send(jsonb_build_object('table', 'pages', 'record', jsonb_build_object('id', old.id, 'table_id', old.table_id, 'deleted', true)),
    'UPDATE', public.chat_topic(old.table_id, old.chat_id), true);
  return null;
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
  return public.start_round(t, c, q, me);
end;
$function$;

CREATE OR REPLACE FUNCTION public.send_with_files(c uuid, body text, files jsonb)
 RETURNS uuid
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
    raise exception 'only the team writes here';
  end if;
  if coalesce(jsonb_array_length(files), 0) = 0 then
    raise exception 'nothing is attached';
  end if;
  me := public.my_member_id(t);
  if char_length(words) = 0 then
    words := left((select string_agg(f ->> 'name', ', ') from jsonb_array_elements(files) f), 500);
  end if;
  insert into public.messages (table_id, chat_id, member_id, body) values (t, c, me, left(words, 8000)) returning id into q;
  got := public.take_files(t, me, files, q);
  update public.messages set meta = meta || jsonb_build_object('files', got) where id = q;
  return q;
end;
$function$;

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
  if t is null or not public.can_see_chat(c) then
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
$function$;

CREATE OR REPLACE FUNCTION public.decide_and_send(d uuid, choice smallint, words text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  dec public.decisions;
  opt public.decision_options;
  me uuid;
  said text := btrim(coalesce(words, ''));
begin
  select * into dec from public.decisions where id = d for update;
  if not found or not public.can_see_chat(dec.chat_id) then
    raise exception 'only the team can decide';
  end if;
  if dec.status <> 'open' then
    raise exception 'this decision is already made';
  end if;
  select * into opt from public.decision_options where decision_id = d and position = choice;
  if not found then
    raise exception 'that option does not exist';
  end if;
  if dec.affects_client then
    if said = '' then
      said := btrim(opt.client_words);
    end if;
    if said = '' then
      raise exception 'write what the client will be told';
    end if;
    if char_length(said) > 2000 then
      raise exception 'what the client is told can be at most 2000 characters';
    end if;
    update public.decision_options set client_words = said where decision_id = d and position = choice;
  end if;
  me := public.my_member_id(dec.table_id);
  update public.decisions
     set status = 'decided', chosen = choice, decided_by = me, decided_at = now(), deliver_after = now()
   where id = d;
  perform public.log_activity(dec.table_id, me, 'decision.decided', d,
    jsonb_build_object('title', dec.title, 'option', opt.label, 'edited', dec.affects_client and said <> btrim(opt.client_words)));
  -- Out now, not on the scheduler's next beat.
  perform public.deliver_due();
end;
$function$;

CREATE OR REPLACE FUNCTION public.rename_chat(c uuid, chat_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ch public.chats;
  clean text := left(btrim(coalesce(chat_name, '')), 60);
begin
  select * into ch from public.chats where id = c;
  if not found or not public.can_see_chat(c) then
    raise exception 'only the team can rename a chat';
  end if;
  if clean = '' then
    raise exception 'a chat needs a name';
  end if;
  update public.chats set name = clean where id = c;
  perform public.log_activity(ch.table_id, public.my_member_id(ch.table_id), 'chat.renamed', c, jsonb_build_object('from', ch.name, 'name', clean));
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_chat(c uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ch public.chats;
  me uuid;
begin
  -- The chat is held first, so a decision being made in it at this moment (which holds it too) finishes before the
  -- requests below are read, and its request is seen and sent back like any other.
  select * into ch from public.chats where id = c for update;
  if not found or not public.can_see_chat(c) then
    raise exception 'only the team can delete a chat';
  end if;
  me := public.my_member_id(ch.table_id);
  if ch.is_general then
    raise exception 'the General chat stays';
  end if;
  if not (public.is_owner(ch.table_id) or ch.created_by = me) then
    raise exception 'only the owner or the person who made this chat can delete it';
  end if;
  -- The chat's decisions are held next, before any request: the clock that delivers a decision holds the decision
  -- and then its request, and taking the two the other way round let a delivery and a deletion wait on each other.
  perform 1 from public.decisions where chat_id = c for update;
  -- A request the team was deciding only in this chat goes back to waiting for them: its decision goes with the chat.
  update public.requests r set status = 'asked', updated_at = now()
   where r.status = 'being decided'
     and exists (select 1 from public.decisions d where d.request_id = r.id and d.chat_id = c)
     and not exists (select 1 from public.decisions d where d.request_id = r.id and d.chat_id <> c);
  delete from public.chats where id = c;
  perform public.log_activity(ch.table_id, me, 'chat.deleted', c, jsonb_build_object('name', ch.name));
  -- Everyone at the table sees it go.
  perform realtime.send(jsonb_build_object('table', 'chats', 'record', jsonb_build_object('id', c, 'deleted', true)),
    'UPDATE', 'team:' || ch.table_id::text, true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.stop_job(job uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  j public.jobs;
  me uuid;
  who text;
begin
  select * into j from public.jobs where id = job;
  if j.round is not null then
    perform pg_advisory_xact_lock(hashtext(j.round::text));
  end if;
  select * into j from public.jobs where id = job for update;
  if not found or not public.is_team(j.table_id) or (j.chat_id is not null and not public.can_see_chat(j.chat_id)) or j.kind in ('client', 'intro') then
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
  update public.tasks set status = 'stopped', finished_at = now() where id = j.task_id and status = 'working'
     and not exists (select 1 from public.jobs o where o.task_id = j.task_id and o.status in ('queued', 'running', 'waiting'));
  perform public.log_activity(j.table_id, me, 'ai.stopped', j.id, jsonb_build_object('kind', j.kind));
end;
$function$;

CREATE OR REPLACE FUNCTION public.team_page(p uuid)
 RETURNS pages
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  pg public.pages;
begin
  select * into pg from public.pages where id = p;
  if not found or not public.can_see_chat(pg.chat_id) then
    raise exception 'that page is not at a table you are on';
  end if;
  return pg;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_table(t uuid, table_name text, undo integer, requests_chat uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.may(t, 'settings') then
    raise exception 'only the owner changes the settings';
  end if;
  if char_length(btrim(coalesce(table_name, ''))) not between 1 and 80 then
    raise exception 'the table needs a name of up to 80 characters';
  end if;
  if undo is null or undo not between 5 and 300 then
    raise exception 'the undo window is 5 to 300 seconds';
  end if;
  if requests_chat is not null and not exists (select 1 from public.chats c where c.id = requests_chat and c.table_id = t and not c.private and c.set_up) then
    raise exception 'that chat is not at this table';
  end if;
  update public.tables set name = btrim(table_name), undo_seconds = undo, client_chat = requests_chat where id = t;
  perform public.log_activity(t, public.my_member_id(t), 'settings.changed', t,
    jsonb_build_object('name', btrim(table_name), 'undo_seconds', undo, 'client_chat', requests_chat));
end;
$function$;

CREATE OR REPLACE FUNCTION public.export_table(t uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_owner(t) then
    raise exception 'only the owner downloads the whole table';
  end if;
  return jsonb_build_object(
    'exported_at', now(),
    'table', (select to_jsonb(x) - 'created_by' from public.tables x where x.id = t),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.display_name, 'role', m.role,
                 'joined', m.created_at, 'removed', m.removed_at) order by m.created_at), '[]') from public.members m where m.table_id = t),
    'chats', (select coalesce(jsonb_agg(to_jsonb(c) - 'search' order by c.created_at), '[]') from public.chats c where c.table_id = t and public.can_see_chat(c.id)),
    'messages', (select coalesce(jsonb_agg(to_jsonb(m) - 'search' order by m.created_at), '[]') from public.messages m where m.table_id = t and public.can_see_chat(m.chat_id)),
    'decisions', (select coalesce(jsonb_agg(to_jsonb(d) || jsonb_build_object('options',
                    (select coalesce(jsonb_agg(to_jsonb(o) order by o.position), '[]') from public.decision_options o where o.decision_id = d.id))
                  order by d.created_at), '[]') from public.decisions d where d.table_id = t and public.can_see_chat(d.chat_id)),
    'requests', (select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('timeline',
                   (select coalesce(jsonb_agg(e.label order by e.id), '[]') from public.request_events e where e.request_id = r.id))
                 order by r.created_at), '[]') from public.requests r where r.table_id = t),
    'told_clients', (select coalesce(jsonb_agg(to_jsonb(u) order by u.created_at), '[]') from public.client_updates u where u.table_id = t),
    'notes', (select coalesce(jsonb_agg(to_jsonb(n) order by n.created_at), '[]') from public.notes n where n.table_id = t),
    -- Pages: each with every version and every comment.
    'pages', (select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object(
                'versions', (select coalesce(jsonb_agg(jsonb_build_object('n', v.n, 'html', v.html, 'note', v.note, 'by_ai', v.by_ai, 'made_by', v.made_by, 'at', v.created_at) order by v.n), '[]') from public.page_versions v where v.page_id = p.id),
                'comments', (select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at), '[]') from public.page_comments c where c.page_id = p.id and c.deleted_at is null))
              order by p.created_at), '[]') from public.pages p where p.table_id = t and public.can_see_chat(p.chat_id)),
    'activity', (select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at), '[]') from public.activity a where a.table_id = t and public.log_line_visible(a.table_id, a.chat_id)));
end;
$function$;

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
      select jsonb_agg(jsonb_build_object('who', l.who, 'body', l.body) order by l.created_at)
        from (select * from public.client_lines l2 where l2.member_id = coalesce(j.subject, j.member_id) and l2.id <> j.line_id
                 -- One of the team's AIs is only handed what was said to the team's assistant. What a client said to
                 -- an assistant they connected themselves is theirs, and the team does not read it.
                 and (j.subject is null or l2.by_table)
               order by l2.created_at desc limit 20) l), '[]'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION public.client_overview(t uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
              from (select * from public.tasks t2 where t2.table_id = t and t2.status in ('working', 'done') and not public.chat_is_private(t2.chat_id)
                       and (t2.reference ->> 'branch' = (select s.branch from public.sandboxes s where s.member_id = me)
                            or (t2.reference ->> 'client' is null
                                and not exists (select 1 from public.members o where o.table_id = t and o.role = 'client' and o.id <> me
                                                  and char_length(regexp_replace(split_part(btrim(o.display_name), ' ', 1), '[^[:alnum:]]', '', 'g')) > 1
                                                  and lower(' ' || regexp_replace(t2.title, '[^[:alnum:]]+', ' ', 'g') || ' ')
                                                      like '% ' || lower(regexp_replace(split_part(btrim(o.display_name), ' ', 1), '[^[:alnum:]]', '', 'g')) || ' %')))
                     order by t2.created_at desc limit 12) w));
end;
$function$;

CREATE OR REPLACE FUNCTION public.start_round(t uuid, c uuid, q uuid, me uuid, task uuid DEFAULT NULL::uuid, title text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer') and public.member_sees_chat(c, m.id)
   where cn.table_id = t and cn.revoked_at is null;
  if seats is null then
    return jsonb_build_object('message_id', q, 'answered_by', null);
  end if;

  if task is null then
    name := btrim(public.hide_secrets(coalesce(nullif(btrim(title), ''), (select left(split_part(m.body, E'\n', 1), 70) from public.messages m where m.id = q), 'Work')));
    task := gen_random_uuid();
    insert into public.tasks (id, table_id, chat_id, member_id, title, branch)
      values (task, t, c, me, left(coalesce(nullif(name, ''), 'Work'), 120),
              'longtable/' || coalesce(nullif(btrim(left(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), 40), '-'), ''), 'work') || '-' || left(task::text, 8));
  else
    update public.tasks set status = 'working', finished_at = null where id = task;
  end if;

  select cn.member_id into online_seat
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer') and public.member_sees_chat(c, m.id)
   where cn.table_id = t and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds'
   order by cn.created_at limit 1;
  select coalesce(tb.final_seat, tb.main_owner), tb.when_final_offline
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
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer') and public.member_sees_chat(c, m.id)
   where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
   order by (cn.member_id = me) desc, cn.created_at limit 1;
  select count(distinct cn.member_id) into claudes
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer') and public.member_sees_chat(c, m.id)
   where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds';
  if worker is not null then
    foreach s in array seats loop
      -- Only an AI that is on right now is asked for its view: one whose computer is closed would hold everyone up.
      if s <> worker and exists (select 1 from public.connections cn where cn.member_id = s and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds') then
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
    if s <> final and exists (select 1 from public.connections cn where cn.member_id = s and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds') then
      insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, task_id) values (t, c, s, q, 'view', r, task);
    end if;
  end loop;
  insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, status, task_id)
    values (t, c, final, q, 'combine', r, 'waiting', task);
  perform public.log_activity(t, me, 'table.asked', q, jsonb_build_object('answered_by', final, 'round', r, 'task', task));
  return jsonb_build_object('message_id', q, 'answered_by', final, 'round', r, 'task', task);
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
    select m.id, m.created_at, m.body, m.by_ai, m.kind = 'client' as client, mem.display_name as name,
           (select jj.id from public.jobs jj where jj.result_message_id = m.id limit 1) as job_id,
           m.meta -> 'pasted' as pasted
      from public.messages m join public.members mem on mem.id = m.member_id
     where m.chat_id = j.chat_id and m.kind in ('chat', 'answer', 'client')
       -- A job with no question of its own (the note-taker's) gets the whole conversation.
       and m.created_at < coalesce(q.created_at, now()) and (j.question_id is null or m.id <> j.question_id)
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
    'pages', public.pages_for_job(j),
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

CREATE OR REPLACE FUNCTION public.runner_page(token text, job uuid, page jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
  pg public.pages;
  html text := coalesce(page ->> 'html', '');
  made integer;
  target uuid;
  mark text := lower(coalesce(nullif(page ->> 'icon', ''), 'page'));
begin
  select * into j from public.jobs where id = job and connection_id = c.id and member_id = c.member_id and status = 'running' for update;
  if not found or j.kind not in ('look', 'answer', 'work', 'combine', 'notes') or j.chat_id is null then
    raise exception 'this job cannot make a page';
  end if;
  if char_length(html) = 0 or char_length(html) > 2000000 then
    raise exception 'a page is between 1 character and 2,000,000';
  end if;
  select count(*) into made from public.page_versions where job_id = j.id;
  if made >= 3 then
    raise exception 'one job makes at most three pages or versions';
  end if;
  html := public.hide_secrets(html);
  if mark !~ '^[a-z]{1,24}$' then mark := 'page'; end if;
  -- The note-taker keeps one handout per chat, its notes, and only ever changes that one.
  if j.kind = 'notes' then
    page := page - 'update' || case when (select ch.notes_page from public.chats ch where ch.id = j.chat_id) is not null
      then jsonb_build_object('update', (select ch.notes_page from public.chats ch where ch.id = j.chat_id)::text) else '{}'::jsonb end;
  end if;
  if nullif(page ->> 'update', '') is not null then
    begin
      target := (page ->> 'update')::uuid;
    exception when others then
      raise exception 'that is not a page here';
    end;
    select * into pg from public.pages where id = target and table_id = j.table_id and chat_id = j.chat_id for update;
    if not found then
      raise exception 'that is not a page here';
    end if;
    update public.pages
       set version = version + 1, touched_at = now(),
           title = coalesce(nullif(left(btrim(public.hide_secrets(coalesce(page ->> 'title', ''))), 120), ''), title),
           about = coalesce(nullif(left(public.hide_secrets(coalesce(page ->> 'about', '')), 300), ''), about),
           icon = case when page ? 'icon' then mark else pages.icon end
     where id = pg.id returning * into pg;
  else
    insert into public.pages (table_id, chat_id, job_id, made_by, title, about, icon)
      values (j.table_id, j.chat_id, j.id, j.member_id,
              coalesce(nullif(left(btrim(public.hide_secrets(coalesce(page ->> 'title', ''))), 120), ''), 'A page'),
              left(public.hide_secrets(coalesce(page ->> 'about', '')), 300), mark)
      returning * into pg;
  end if;
  if j.kind = 'notes' then
    update public.chats set notes_page = pg.id where id = j.chat_id and notes_page is distinct from pg.id;
  end if;
  insert into public.page_versions (page_id, table_id, n, html, job_id, made_by, by_ai, note)
    values (pg.id, pg.table_id, pg.version, html, j.id, j.member_id, true, left(public.hide_secrets(coalesce(page ->> 'note', '')), 200));
  return pg.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.hear_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.by_ai or new.kind <> 'chat' or coalesce(current_setting('longtable.asked', true), '') = '1' then
    return null;
  end if;
  if public.final_seat_now(new.table_id) is null then
    return null;
  end if;
  if exists (select 1 from public.chats ch where ch.id = new.chat_id and (not ch.set_up or ch.answers = 'silent')) then
    return null;
  end if;
  insert into public.listens (chat_id, table_id, since, due_at)
    values (new.chat_id, new.table_id, new.created_at, now() + interval '4 seconds')
    on conflict (chat_id) do update set due_at = excluded.due_at, since = least(public.listens.since, excluded.since);
  return null;
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
    end loop;
    if skipped is not null then
      insert into public.listens (chat_id, table_id, since, due_at) values (l.chat_id, l.table_id, skipped, now() + interval '5 seconds')
        on conflict (chat_id) do update set since = least(public.listens.since, excluded.since), due_at = least(public.listens.due_at, excluded.due_at);
    end if;
  end loop;
  return n;
end;
$function$;


create function public.leave_rooms_when_removed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.removed_at is not null and old.removed_at is null then
    delete from public.chat_people where member_id = new.id;
  end if;
  return null;
end;
$$;
create trigger leave_rooms_when_removed after update of removed_at on public.members for each row execute function public.leave_rooms_when_removed();

-- Setting a chat up, or changing how it is set up: by whoever made it, or an owner (a chat nobody made, the table's
-- own Chat room, is the owners'). Name, what it is for, who is in it, notes, and how the AIs answer.
create function public.setup_chat(c uuid, chat_name text, chat_about text, who text, people uuid[], take_notes boolean, ai_answers text)
returns void language plpgsql security definer set search_path = '' as $$
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
  if coalesce(ai_answers, '') not in ('normal', 'named', 'silent') then
    raise exception 'the AIs answer normally, when named, or never';
  end if;
  if who = 'some' and exists (select 1 from unnest(coalesce(people, '{}')) p
                               where not exists (select 1 from public.members m where m.id = p and m.table_id = ch.table_id
                                                   and m.role in ('owner', 'developer') and m.removed_at is null)) then
    raise exception 'only people on the team can be in a chat';
  end if;
  update public.chats set name = clean, about = btrim(coalesce(chat_about, '')), private = who <> 'everyone',
         notes = coalesce(take_notes, false), answers = ai_answers, set_up = true,
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
  -- Nobody may be left reading a room from the requests side: a private chat never takes clients' requests.
  update public.tables set client_chat = null where id = ch.table_id and client_chat = c and who <> 'everyone';
  if coalesce(current_setting('longtable.making_chat', true), '') <> '1' then
    perform public.log_activity(ch.table_id, me, 'chat.set_up', c, jsonb_build_object('name', clean));
  end if;
end;
$$;
revoke all on function public.setup_chat(uuid, text, text, text, uuid[], boolean, text) from public, anon;
grant execute on function public.setup_chat(uuid, text, text, text, uuid[], boolean, text) to authenticated;

-- A new chat from the "+": made and set up in one go by whoever makes it.
create function public.make_chat(t uuid, chat_name text, chat_about text, who text, people uuid[], take_notes boolean, ai_answers text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  c uuid;
  me uuid := public.my_member_id(t);
begin
  if not public.is_team(t) then
    raise exception 'only the team can make chats';
  end if;
  if char_length(btrim(coalesce(chat_name, ''))) not between 1 and 60 then
    raise exception 'a chat needs a name of up to 60 characters';
  end if;
  if who not in ('everyone', 'some', 'me') then
    raise exception 'a chat is for everyone, some people, or just you';
  end if;
  -- Made private from its first moment, so the team's channel never carries its name, only that a chat changed.
  insert into public.chats (table_id, name, about, created_by, private, set_up)
    values (t, left(btrim(chat_name), 60), '', me, who <> 'everyone', false) returning id into c;
  insert into public.chat_people (chat_id, member_id) values (c, me) on conflict do nothing;
  -- One line in the log for a new chat: that it was made (setting it up in the same moment is part of making it).
  perform set_config('longtable.making_chat', '1', true);
  perform public.setup_chat(c, chat_name, chat_about, who, people, take_notes, ai_answers);
  perform set_config('longtable.making_chat', '', true);
  perform public.log_activity(t, me, 'chat.created', c, jsonb_build_object('name', left(btrim(chat_name), 60)));
  return c;
end;
$$;
revoke all on function public.make_chat(uuid, text, text, text, uuid[], boolean, text) from public, anon;
grant execute on function public.make_chat(uuid, text, text, text, uuid[], boolean, text) to authenticated;

-- Every table has a Chat room beside General, waiting for its owner to set it up.

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
  insert into public.chats (table_id, name, about, set_up) values (t, 'Chat room', '', false);
  perform public.log_activity(t, me, 'table.started', t, jsonb_build_object('name', btrim(table_name)));
  return t;
end;
$function$;

insert into public.chats (table_id, name, about, set_up)
  select tb.id, 'Chat room', '', false from public.tables tb
   where not exists (select 1 from public.chats ch where ch.table_id = tb.id and ch.name = 'Chat room');

-- The note-taker: a chat with notes on gets a notes job on the AI of someone in it, once people have gone quiet for a
-- minute after saying something new (or after fifteen new messages), never two at once.
create function public.notes_now()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  ch public.chats;
  seat uuid;
  n integer := 0;
begin
  update public.jobs set status = 'skipped', lease_until = null, error = 'nobody picked it up'
   where kind = 'notes' and ((status = 'queued' and created_at < now() - interval '10 minutes')
                          or (status = 'running' and lease_until < now() - interval '2 minutes'));
  for ch in select * from public.chats c where c.notes and c.set_up loop
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
$$;
revoke all on function public.notes_now() from public, anon, authenticated;
select cron.schedule('longtable-notes', '30 seconds', $$select public.notes_now()$$);

-- Older functions that only asked whether someone is on the team: a private room's decisions and comments are its people's.
CREATE OR REPLACE FUNCTION public.decide(d uuid, choice smallint)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  dec public.decisions;
  wait integer;
  me uuid;
begin
  select * into dec from public.decisions where id = d for update;
  if not found or not public.can_see_chat(dec.chat_id) then
    raise exception 'only the team can decide';
  end if;
  if dec.status <> 'open' then
    raise exception 'this decision is already made';
  end if;
  if not exists (select 1 from public.decision_options where decision_id = d and position = choice) then
    raise exception 'that option does not exist';
  end if;
  select undo_seconds into wait from public.tables where id = dec.table_id;
  me := public.my_member_id(dec.table_id);
  update public.decisions
     set status = 'decided', chosen = choice, decided_by = me, decided_at = now(),
         deliver_after = now() + make_interval(secs => wait)
   where id = d;
  perform public.log_activity(dec.table_id, me, 'decision.decided', d,
    jsonb_build_object('title', dec.title, 'option', (select label from public.decision_options where decision_id = d and position = choice)));
  return now() + make_interval(secs => wait);
end;
$function$;

CREATE OR REPLACE FUNCTION public.undo_decision(d uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  dec public.decisions;
begin
  select * into dec from public.decisions where id = d for update;
  if not found or not public.can_see_chat(dec.chat_id) then
    raise exception 'only the team can undo';
  end if;
  if dec.status <> 'decided' or dec.delivered_at is not null or dec.deliver_after <= now() then
    raise exception 'too late to undo';
  end if;
  update public.decisions
     set status = 'open', chosen = null, decided_by = null, decided_at = null, deliver_after = null
   where id = d;
  perform public.log_activity(dec.table_id, public.my_member_id(dec.table_id), 'decision.undone', d, jsonb_build_object('title', dec.title));
end;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_page_comment(cm uuid, done boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  x public.page_comments;
begin
  select * into x from public.page_comments where id = cm;
  if not found or not exists (select 1 from public.pages p where p.id = x.page_id and public.can_see_chat(p.chat_id)) then
    raise exception 'that comment is not at a table you are on';
  end if;
  update public.page_comments
     set resolved_at = case when done then now() end, resolved_by = case when done then public.my_member_id(x.table_id) end
   where id = cm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_page_comment(cm uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  x public.page_comments;
begin
  select * into x from public.page_comments where id = cm;
  if not found or not exists (select 1 from public.pages p where p.id = x.page_id and public.can_see_chat(p.chat_id)) then
    raise exception 'that comment is not at a table you are on';
  end if;
  if x.member_id is distinct from public.my_member_id(x.table_id) and not public.is_owner(x.table_id) then
    raise exception 'only whoever wrote a comment, or the owner, takes it away';
  end if;
  update public.page_comments set deleted_at = now(), body = '', anchor = '' where id = cm;
end;
$function$;
