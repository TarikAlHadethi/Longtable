-- Step 5: the client's page. A client asks for things in their own words; each ask becomes a request with a
-- timeline the client can see, lands in the team's chat as a client card, and links to the decision about it.
-- The client still sees nothing of the team side: only their own requests, their timeline and what they are told.
-- Two clients at one table do not see each other's requests: each hears their own on a channel of their own.

-- Where client requests land in the team's chats. Defaults to General.
alter table public.tables add column client_chat uuid references public.chats (id) on delete set null;

-- Client cards in the team chat.
alter table public.messages drop constraint messages_kind_check;
alter table public.messages add constraint messages_kind_check check (kind in ('chat', 'answer', 'view', 'intro', 'client'));

create table public.requests (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  status text not null default 'asked' check (status in ('asked', 'being decided', 'decided', 'planned', 'ready to try', 'done')),
  message_id uuid references public.messages (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index requests_table_idx on public.requests (table_id, created_at desc);
create index requests_member_idx on public.requests (member_id, created_at desc);

-- The timeline the client sees, in plain words.
create table public.request_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.requests (id) on delete cascade,
  table_id uuid not null references public.tables (id) on delete cascade,
  label text not null,
  created_at timestamptz not null default now()
);
create index request_events_request_idx on public.request_events (request_id, id);

alter table public.decisions add column request_id uuid references public.requests (id) on delete set null;
alter table public.client_updates add column request_id uuid references public.requests (id) on delete set null;

alter table public.requests enable row level security;
alter table public.request_events enable row level security;
revoke all on public.requests, public.request_events from anon;

-- The team sees every request; a client sees only their own.
create policy "the team and the asker read requests" on public.requests
  for select to authenticated
  using (public.is_team(table_id) or member_id = public.my_member_id(table_id));
create policy "the team and the asker read the timeline" on public.request_events
  for select to authenticated
  using (exists (select 1 from public.requests r where r.id = request_id
                 and (public.is_team(r.table_id) or r.member_id = public.my_member_id(r.table_id))));

-- What the client is told: the team reads all of it; a client reads what was said to every client at the table
-- and what was said about their own requests, never what was said about someone else's.
drop policy "everyone at the table reads client updates" on public.client_updates;
create policy "the team, and the client it was said to, read client updates" on public.client_updates
  for select to authenticated
  using (public.is_team(table_id)
         or (public.is_member(table_id)
             and (request_id is null
                  or exists (select 1 from public.requests r
                              where r.id = request_id and r.member_id = public.my_member_id(table_id)))));

create function public.add_request_event(req uuid, words text)
returns void language sql security definer set search_path = '' as $$
  insert into public.request_events (request_id, table_id, label)
    select r.id, r.table_id, words from public.requests r where r.id = req;
$$;
revoke all on function public.add_request_event(uuid, text) from public, anon, authenticated;

-- A client asks for something. It becomes a request, a card in the team's chat, and a note back to the client.
-- The card carries the request's id from the start, so the team's screen can show its status as soon as it lands.
create function public.client_ask(t uuid, body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me public.members;
  req uuid := gen_random_uuid();
  msg uuid;
  landing uuid;
  words text := btrim(coalesce(body, ''));
begin
  select * into me from public.members where table_id = t and user_id = auth.uid();
  if not found or me.role <> 'client' then
    raise exception 'only the client asks here';
  end if;
  if char_length(words) = 0 then
    raise exception 'ask for something';
  end if;
  if (select count(*) from public.requests r where r.member_id = me.id and r.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'that is a lot of requests in one hour, try again a little later';
  end if;
  select coalesce(tb.client_chat, (select c.id from public.chats c where c.table_id = t and c.is_general))
    into landing from public.tables tb where tb.id = t;
  insert into public.messages (table_id, chat_id, member_id, body, kind, meta)
    values (t, landing, me.id, left(words, 4000), 'client', jsonb_build_object('request', req))
    returning id into msg;
  insert into public.requests (id, table_id, member_id, title, body, message_id)
    values (req, t, me.id, left(regexp_replace(words, '\s+', ' ', 'g'), 120), left(words, 4000), msg);
  perform public.add_request_event(req, 'You asked');
  insert into public.client_updates (table_id, request_id, body)
    values (t, req, 'Passed on to the team. You will hear here what they decide.');
  perform public.log_activity(t, me.id, 'client.asked', req, jsonb_build_object('title', left(words, 120)));
  return req;
end;
$$;
revoke all on function public.client_ask(uuid, text) from public, anon;
grant execute on function public.client_ask(uuid, text) to authenticated;

-- Decisions can be about a client's request. The request then shows it is being decided.
drop function public.create_decision(uuid, text, text, text, boolean, jsonb);
create function public.create_decision(c uuid, title text, context text, origin text, affects_client boolean, options jsonb, request uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  t uuid;
  d uuid;
  me uuid;
  n int := jsonb_array_length(coalesce(options, '[]'::jsonb));
  i int;
  o jsonb;
begin
  select ch.table_id into t from public.chats ch where ch.id = c;
  if t is null or not public.is_team(t) then
    raise exception 'only the team can ask for a decision';
  end if;
  if n < 2 or n > 4 then
    raise exception 'a decision needs two to four options';
  end if;
  if request is not null and not exists (select 1 from public.requests r where r.id = request and r.table_id = t) then
    raise exception 'that request is not at this table';
  end if;
  me := public.my_member_id(t);
  insert into public.decisions (table_id, chat_id, title, context, origin, affects_client, created_by, request_id)
    values (t, c, btrim(title), btrim(coalesce(context, '')), btrim(coalesce(origin, '')), coalesce(affects_client, false) or request is not null, me, request)
    returning id into d;
  for i in 0 .. n - 1 loop
    o := options -> i;
    insert into public.decision_options (decision_id, position, label, recommended, client_words)
      values (d, i + 1, btrim(o ->> 'label'), coalesce((o ->> 'recommended')::boolean, false), btrim(coalesce(o ->> 'client_words', '')));
  end loop;
  -- A new request, or a follow-up on one already decided, goes back to being decided. A request that is planned,
  -- ready to try or done keeps its status, and a second decision on a request already being decided adds nothing.
  if request is not null then
    update public.requests set status = 'being decided', updated_at = now()
     where id = request and status in ('asked', 'decided');
    if found then
      perform public.add_request_event(request, 'The team is deciding');
    end if;
  end if;
  perform public.log_activity(t, me, 'decision.created', d, jsonb_build_object('title', btrim(title)));
  return d;
end;
$$;
revoke all on function public.create_decision(uuid, text, text, text, boolean, jsonb, uuid) from public, anon;
grant execute on function public.create_decision(uuid, text, text, text, boolean, jsonb, uuid) to authenticated;

-- Delivery now also moves the request along. The timeline shows the client's words for the choice, never the
-- team's own label for it, which was written for the team.
create or replace function public.deliver_due()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  dec public.decisions;
  words text;
  n integer := 0;
begin
  for dec in
    select * from public.decisions
     where status = 'decided' and delivered_at is null and deliver_after <= now()
     order by deliver_after
     for update skip locked
  loop
    select btrim(client_words) into words from public.decision_options where decision_id = dec.id and position = dec.chosen;
    if dec.affects_client and coalesce(words, '') <> '' then
      insert into public.client_updates (table_id, decision_id, request_id, body) values (dec.table_id, dec.id, dec.request_id, words);
    end if;
    if dec.request_id is not null then
      update public.requests set status = 'decided', updated_at = now() where id = dec.request_id;
      perform public.add_request_event(dec.request_id, coalesce(nullif(words, ''), 'The team decided'));
    end if;
    update public.decisions set delivered_at = now() where id = dec.id;
    perform public.log_activity(dec.table_id, null, 'decision.delivered', dec.id,
      jsonb_build_object('title', dec.title, 'told_client', dec.affects_client));
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Each client's own channel: client:<table>:<member>. Only that person may listen to it.
create function public.client_topic_is_mine(topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when topic ~ '^client:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then exists (select 1 from public.members m
                  where m.table_id = substring(topic from 8 for 36)::uuid
                    and m.id = substring(topic from 45 for 36)::uuid
                    and m.user_id = auth.uid())
    else false
  end;
$$;

create policy "a client hears their own channel" on realtime.messages
  for select to authenticated
  using (public.client_topic_is_mine(realtime.topic()));

-- Live: a request and its timeline go to the person who asked, on their own channel. The team hears requests
-- (not the timeline, which is written for the client) on the team channel.
create function public.broadcast_request_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  asker uuid;
begin
  if tg_table_name = 'requests' then
    asker := new.member_id;
    perform realtime.broadcast_changes('team:' || new.table_id::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, null);
  else
    select r.member_id into asker from public.requests r where r.id = new.request_id;
  end if;
  if asker is not null then
    perform realtime.broadcast_changes('client:' || new.table_id::text || ':' || asker::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, null);
  end if;
  return null;
end;
$$;
create trigger requests_broadcast after insert or update on public.requests
  for each row execute function public.broadcast_request_change();
create trigger request_events_broadcast after insert on public.request_events
  for each row execute function public.broadcast_request_change();

-- What the client is told: about one person's request, on that person's channel; otherwise on the table's
-- client channel, which every client at the table hears.
create or replace function public.broadcast_client_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  asker uuid;
begin
  if new.request_id is not null then
    select r.member_id into asker from public.requests r where r.id = new.request_id;
  end if;
  perform realtime.broadcast_changes('client:' || new.table_id::text || coalesce(':' || asker::text, ''),
    tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
  return null;
end;
$$;

-- The AIs read what the client asked as part of the chat, marked as the client's.
create or replace function public.runner_claim(token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
    order by (kind = 'combine') desc, created_at
    limit 1
    for update skip locked;
  if not found then
    return null;
  end if;
  update public.jobs
     set status = 'running', attempts = attempts + 1, lease_until = now() + interval '5 minutes',
         connection_id = c.id, started_at = now()
   where id = j.id;
  select * into q from public.messages where id = j.question_id;

  select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb) into history from (
    select m.created_at, m.body, m.by_ai, m.kind = 'client' as client, mem.display_name as name
      from public.messages m join public.members mem on mem.id = m.member_id
     where m.chat_id = j.chat_id and m.kind in ('chat', 'answer', 'client')
       and m.created_at < coalesce(q.created_at, now()) and m.id <> coalesce(j.question_id, m.id)
     order by m.created_at desc
     limit 20
  ) x;

  if j.kind = 'combine' then
    select coalesce(jsonb_agg(jsonb_build_object('name', mem.display_name, 'view', m.body, 'meta', m.meta) order by m.created_at), '[]'::jsonb)
      into views
      from public.messages m join public.members mem on mem.id = m.member_id
     where m.kind = 'view' and m.meta ->> 'round' = j.round::text;
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
    'question', q.body,
    'history', history,
    'views', views,
    'related', related,
    'pinned', pinned);
end;
$$;

-- Who may call what. Found in the step 4 check, where the team's two Claudes read the step 2 code: Supabase grants
-- every new function to signed-in users by default, so revoking deliver_due from public and anon left people able
-- to call it. It could deliver nothing early, but only the scheduler should run it. And the functions people use
-- only after signing in no longer answer signed-out callers at all; each one already refused them inside.
revoke all on function public.deliver_due() from authenticated;
revoke all on function public.accept_invite(text, text), public.start_table(text, text), public.create_invite(uuid, public.member_role),
  public.disconnect(uuid), public.start_pairing(uuid, text), public.ask_table(uuid, text) from public, anon;
grant execute on function public.accept_invite(text, text), public.start_table(text, text), public.create_invite(uuid, public.member_role),
  public.disconnect(uuid), public.start_pairing(uuid, text), public.ask_table(uuid, text) to authenticated;
