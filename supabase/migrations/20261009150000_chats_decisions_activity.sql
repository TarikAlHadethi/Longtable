-- Step 2: chats inside a table, decision cards with an undo window, what the client is told, and the activity log.
-- Everything here is team only, except client_updates, which is what the client hears and only after the window.

-- Settings that belong to a table. The undo window defaults to 10 seconds.
alter table public.tables add column undo_seconds integer not null default 10 check (undo_seconds between 0 and 300);

-- Chats. Every table has exactly one General.
create table public.chats (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  about text not null default '' check (char_length(about) <= 140),
  is_general boolean not null default false,
  created_by uuid references public.members (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, table_id)
);
create unique index chats_one_general on public.chats (table_id) where is_general;
create index chats_table_idx on public.chats (table_id, created_at);

insert into public.chats (table_id, name, about, is_general)
  select id, 'General', 'Everyone on the team', true from public.tables;

alter table public.messages add column chat_id uuid;
update public.messages m set chat_id = c.id from public.chats c where c.table_id = m.table_id and c.is_general;
alter table public.messages alter column chat_id set not null;
-- A message's chat always belongs to the message's table.
alter table public.messages add constraint messages_chat_fk
  foreign key (chat_id, table_id) references public.chats (id, table_id) on delete cascade;
create index messages_chat_time_idx on public.messages (chat_id, created_at desc);

-- Decisions: a question with two to four options, decided with one tap.
create type public.decision_status as enum ('open', 'decided', 'withdrawn');

create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  chat_id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 140),
  context text not null default '' check (char_length(context) <= 1000),
  origin text not null default '' check (char_length(origin) <= 120),
  affects_client boolean not null default false,
  status public.decision_status not null default 'open',
  chosen smallint,
  decided_by uuid references public.members (id) on delete set null,
  decided_at timestamptz,
  deliver_after timestamptz,
  delivered_at timestamptz,
  created_by uuid references public.members (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (chat_id, table_id) references public.chats (id, table_id) on delete cascade
);
create index decisions_table_idx on public.decisions (table_id, created_at desc);
create index decisions_due_idx on public.decisions (deliver_after) where status = 'decided' and delivered_at is null;

create table public.decision_options (
  decision_id uuid not null references public.decisions (id) on delete cascade,
  position smallint not null check (position between 1 and 4),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  recommended boolean not null default false,
  client_words text not null default '' check (char_length(client_words) <= 1000),
  primary key (decision_id, position)
);

-- What the client hears. Written only by the delivery step, after the undo window has closed.
create table public.client_updates (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  decision_id uuid references public.decisions (id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index client_updates_table_idx on public.client_updates (table_id, created_at desc);

-- The activity log: append-only. Rows go only when their whole table is deleted on purpose.
create table public.activity (
  id bigint generated always as identity primary key,
  table_id uuid not null references public.tables (id) on delete cascade,
  -- A plain id, not a foreign key: removing a person must never rewrite the log.
  actor uuid,
  action text not null,
  subject uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index activity_table_idx on public.activity (table_id, id desc);

create function public.activity_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('longtable.deleting_table', true) = 'on' then
    return old;
  end if;
  raise exception 'the activity log is append-only';
end;
$$;
create trigger activity_append_only before update or delete on public.activity
  for each row execute function public.activity_append_only();

create function public.log_activity(t uuid, actor uuid, act text, subj uuid, info jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.activity (table_id, actor, action, subject, details) values (t, actor, act, subj, coalesce(info, '{}'::jsonb));
$$;
revoke all on function public.log_activity(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated;

-- Row level security: the team reads chats, decisions and the log; everyone at the table reads client updates.
alter table public.chats enable row level security;
alter table public.decisions enable row level security;
alter table public.decision_options enable row level security;
alter table public.client_updates enable row level security;
alter table public.activity enable row level security;
revoke all on public.chats, public.decisions, public.decision_options, public.client_updates, public.activity from anon;

create policy "the team reads its chats" on public.chats
  for select to authenticated using (public.is_team(table_id));
create policy "the team reads its decisions" on public.decisions
  for select to authenticated using (public.is_team(table_id));
create policy "the team reads decision options" on public.decision_options
  for select to authenticated using (exists (select 1 from public.decisions d where d.id = decision_id and public.is_team(d.table_id)));
create policy "everyone at the table reads client updates" on public.client_updates
  for select to authenticated using (public.is_member(table_id));
create policy "the team reads the activity log" on public.activity
  for select to authenticated using (public.is_team(table_id));
-- No insert, update or delete policies on any of these: they change only through the functions below.

-- Starting a table now also sets up General and logs it.
create or replace function public.start_table(table_name text, my_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  t uuid;
  me uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  insert into public.tables (name, created_by) values (btrim(table_name), auth.uid()) returning id into t;
  insert into public.members (table_id, user_id, role, display_name, color)
    values (t, auth.uid(), 'owner', btrim(my_name), public.next_color(t)) returning id into me;
  insert into public.chats (table_id, name, about, is_general, created_by) values (t, 'General', 'Everyone on the team', true, me);
  perform public.log_activity(t, me, 'table.started', t, jsonb_build_object('name', btrim(table_name)));
  return t;
end;
$$;

create or replace function public.create_invite(t uuid, invite_role public.member_role)
returns text language plpgsql security definer set search_path = '' as $$
declare
  raw text;
  inv uuid;
begin
  if not public.is_owner(t) then
    raise exception 'only the owner can invite';
  end if;
  if invite_role = 'owner' then
    raise exception 'a table has one owner';
  end if;
  raw := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.invites (table_id, role, token_hash, created_by)
    values (t, invite_role, encode(extensions.digest(raw, 'sha256'), 'hex'), auth.uid()) returning id into inv;
  perform public.log_activity(t, public.my_member_id(t), 'invite.created', inv, jsonb_build_object('role', invite_role));
  return raw;
end;
$$;

create or replace function public.accept_invite(token text, my_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  inv public.invites;
  me uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  select * into inv from public.invites
    where token_hash = encode(extensions.digest(token, 'sha256'), 'hex')
    for update;
  if not found then
    raise exception 'this invite link is not valid';
  end if;
  if exists (select 1 from public.members m where m.table_id = inv.table_id and m.user_id = auth.uid()) then
    return inv.table_id;
  end if;
  if inv.used_at is not null then
    raise exception 'this invite link was already used';
  end if;
  if inv.expires_at < now() then
    raise exception 'this invite link has expired';
  end if;
  insert into public.members (table_id, user_id, role, display_name, color)
    values (inv.table_id, auth.uid(), inv.role, btrim(my_name), public.next_color(inv.table_id)) returning id into me;
  update public.invites set used_by = auth.uid(), used_at = now() where id = inv.id;
  perform public.log_activity(inv.table_id, me, 'member.joined', me, jsonb_build_object('role', inv.role, 'name', btrim(my_name)));
  return inv.table_id;
end;
$$;

-- A new chat.
create function public.create_chat(t uuid, chat_name text, chat_about text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  c uuid;
  me uuid := public.my_member_id(t);
begin
  if not public.is_team(t) then
    raise exception 'only the team can make chats';
  end if;
  insert into public.chats (table_id, name, about, created_by) values (t, btrim(chat_name), btrim(coalesce(chat_about, '')), me)
    returning id into c;
  perform public.log_activity(t, me, 'chat.created', c, jsonb_build_object('name', btrim(chat_name)));
  return c;
end;
$$;

-- A decision card. options: [{"label": "...", "recommended": true, "client_words": "..."}], two to four of them.
create function public.create_decision(c uuid, title text, context text, origin text, affects_client boolean, options jsonb)
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
  me := public.my_member_id(t);
  insert into public.decisions (table_id, chat_id, title, context, origin, affects_client, created_by)
    values (t, c, btrim(title), btrim(coalesce(context, '')), btrim(coalesce(origin, '')), coalesce(affects_client, false), me)
    returning id into d;
  for i in 0 .. n - 1 loop
    o := options -> i;
    insert into public.decision_options (decision_id, position, label, recommended, client_words)
      values (d, i + 1, btrim(o ->> 'label'), coalesce((o ->> 'recommended')::boolean, false), btrim(coalesce(o ->> 'client_words', '')));
  end loop;
  perform public.log_activity(t, me, 'decision.created', d, jsonb_build_object('title', btrim(title)));
  return d;
end;
$$;

-- One tap decides. If the client is affected, they hear only after the undo window.
create function public.decide(d uuid, choice smallint)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  dec public.decisions;
  wait integer;
  me uuid;
begin
  select * into dec from public.decisions where id = d for update;
  if not found or not public.is_team(dec.table_id) then
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
$$;

-- Undo, only while the window is open and before anything reached the client.
create function public.undo_decision(d uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  dec public.decisions;
begin
  select * into dec from public.decisions where id = d for update;
  if not found or not public.is_team(dec.table_id) then
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
$$;

-- Delivery: once the window closes, the client is told, in the exact words on the chosen option.
create function public.deliver_due()
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
    if dec.affects_client then
      select client_words into words from public.decision_options where decision_id = dec.id and position = dec.chosen;
      if coalesce(btrim(words), '') <> '' then
        insert into public.client_updates (table_id, decision_id, body) values (dec.table_id, dec.id, words);
      end if;
    end if;
    update public.decisions set delivered_at = now() where id = dec.id;
    perform public.log_activity(dec.table_id, null, 'decision.delivered', dec.id,
      jsonb_build_object('title', dec.title, 'told_client', dec.affects_client));
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.create_chat(uuid, text, text), public.create_decision(uuid, text, text, text, boolean, jsonb),
  public.decide(uuid, smallint), public.undo_decision(uuid), public.deliver_due() from public, anon;
grant execute on function public.create_chat(uuid, text, text), public.create_decision(uuid, text, text, text, boolean, jsonb),
  public.decide(uuid, smallint), public.undo_decision(uuid) to authenticated;
-- deliver_due is never callable by people; only the scheduler runs it.

-- The scheduler: every two seconds, deliver what is due. So the client hears 10 to 12 seconds after a decision.
create extension if not exists pg_cron;
select cron.schedule('longtable-deliver-due', '2 seconds', 'select public.deliver_due()');

-- Live updates for the team: chats and decisions, on the same private team channel as messages.
create function public.broadcast_team_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.broadcast_changes('team:' || new.table_id::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
  return null;
end;
$$;
create trigger chats_broadcast after insert or update on public.chats
  for each row execute function public.broadcast_team_change();
create trigger decisions_broadcast after insert or update on public.decisions
  for each row execute function public.broadcast_team_change();

-- What the client hears goes out on the table's client channel, which everyone at the table may listen to.
create function public.broadcast_client_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.broadcast_changes('client:' || new.table_id::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
  return null;
end;
$$;
create trigger client_updates_broadcast after insert on public.client_updates
  for each row execute function public.broadcast_client_update();

create function public.client_topic_table_id(topic text)
returns uuid language sql immutable set search_path = '' as $$
  select case when topic ~ '^client:[0-9a-f-]{36}$' then substring(topic from 8)::uuid else null end;
$$;

create policy "everyone at the table hears the client channel" on realtime.messages
  for select to authenticated
  using (public.is_member(public.client_topic_table_id(realtime.topic())));
