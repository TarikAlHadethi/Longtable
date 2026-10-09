-- Step 1: tables, the people at them, invite links, and the team's messages.
-- The wall lives here, in the database: a client can see their table and its people, never the team's messages.

create extension if not exists pgcrypto with schema extensions;

create type public.member_role as enum ('owner', 'developer', 'client');

create table public.tables (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create table public.members (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  color text not null,
  created_at timestamptz not null default now(),
  unique (table_id, user_id)
);
create index members_user_idx on public.members (user_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 8000),
  created_at timestamptz not null default now()
);
create index messages_table_time_idx on public.messages (table_id, created_at desc);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  role public.member_role not null check (role <> 'owner'),
  token_hash text not null unique,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid references auth.users (id),
  used_at timestamptz
);

-- Questions the rules ask. Security definer, so a policy on members can ask about members without recursing.
create function public.is_member(t uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m where m.table_id = t and m.user_id = auth.uid());
$$;

create function public.is_team(t uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m
                 where m.table_id = t and m.user_id = auth.uid() and m.role in ('owner', 'developer'));
$$;

create function public.is_owner(t uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m where m.table_id = t and m.user_id = auth.uid() and m.role = 'owner');
$$;

create function public.my_member_id(t uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select m.id from public.members m where m.table_id = t and m.user_id = auth.uid();
$$;

alter table public.tables enable row level security;
alter table public.members enable row level security;
alter table public.messages enable row level security;
alter table public.invites enable row level security;

-- Nobody signed out reads or writes anything directly.
revoke all on public.tables, public.members, public.messages, public.invites from anon;

create policy "members read their tables" on public.tables
  for select to authenticated using (public.is_member(id));

create policy "members read the people at their tables" on public.members
  for select to authenticated using (public.is_member(table_id));

create policy "the team reads its messages" on public.messages
  for select to authenticated using (public.is_team(table_id));

create policy "the team writes messages as itself" on public.messages
  for insert to authenticated with check (public.is_team(table_id) and member_id = public.my_member_id(table_id));

-- No update or delete policies: messages are append-only. Tables, members and invites change only through the
-- functions below, so there are no insert policies on them either.

-- Colours in the order people join: Clay, Slate, Heather, then more seats.
create function public.next_color(t uuid)
returns text language sql stable security definer set search_path = '' as $$
  select (array['oklch(0.62 0.09 30)', 'oklch(0.62 0.09 250)', 'oklch(0.62 0.09 310)',
                'oklch(0.62 0.09 120)', 'oklch(0.62 0.09 70)', 'oklch(0.62 0.09 200)'])
         [1 + ((select count(*) from public.members m where m.table_id = t)::int % 6)];
$$;

-- Start a table: the table and its owner in one step.
create function public.start_table(table_name text, my_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  t uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  insert into public.tables (name, created_by) values (btrim(table_name), auth.uid()) returning id into t;
  insert into public.members (table_id, user_id, role, display_name, color)
    values (t, auth.uid(), 'owner', btrim(my_name), public.next_color(t));
  return t;
end;
$$;

-- An invite link. Only the owner makes one; the raw token is returned once and only its hash is kept.
create function public.create_invite(t uuid, invite_role public.member_role)
returns text language plpgsql security definer set search_path = '' as $$
declare
  raw text;
begin
  if not public.is_owner(t) then
    raise exception 'only the owner can invite';
  end if;
  if invite_role = 'owner' then
    raise exception 'a table has one owner';
  end if;
  raw := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.invites (table_id, role, token_hash, created_by)
    values (t, invite_role, encode(extensions.digest(raw, 'sha256'), 'hex'), auth.uid());
  return raw;
end;
$$;

-- What an invite is for, before accepting it: the table's name and the role only.
create function public.invite_preview(token text)
returns table (table_name text, role public.member_role, expired boolean, used boolean)
language sql stable security definer set search_path = '' as $$
  select t.name, i.role, i.expires_at < now(), i.used_at is not null
  from public.invites i
  join public.tables t on t.id = i.table_id
  where i.token_hash = encode(extensions.digest(token, 'sha256'), 'hex');
$$;

-- Accept an invite: one use, before it expires. Someone already at the table just gets the table back.
create function public.accept_invite(token text, my_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  inv public.invites;
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
    values (inv.table_id, auth.uid(), inv.role, btrim(my_name), public.next_color(inv.table_id));
  update public.invites set used_by = auth.uid(), used_at = now() where id = inv.id;
  return inv.table_id;
end;
$$;

revoke all on function public.is_member(uuid), public.is_team(uuid), public.is_owner(uuid),
  public.my_member_id(uuid), public.next_color(uuid) from public, anon;
grant execute on function public.is_member(uuid), public.is_team(uuid), public.is_owner(uuid),
  public.my_member_id(uuid) to authenticated;
revoke all on function public.start_table(text, text), public.create_invite(uuid, public.member_role),
  public.accept_invite(text, text), public.invite_preview(text) from public;
grant execute on function public.start_table(text, text), public.create_invite(uuid, public.member_role),
  public.accept_invite(text, text) to authenticated;
grant execute on function public.invite_preview(text) to anon, authenticated;

-- Live updates: every new team message goes out on its table's private channel, straight from the database.
create function public.broadcast_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.broadcast_changes('team:' || new.table_id::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
  return null;
end;
$$;
create trigger messages_broadcast after insert on public.messages
  for each row execute function public.broadcast_message();

-- Who may listen on a team channel, and show up as online there: the team of that table, nobody else.
-- People may send presence, never broadcasts, so nobody can fake a message on the channel.
create function public.topic_table_id(topic text)
returns uuid language sql immutable set search_path = '' as $$
  select case when topic ~ '^team:[0-9a-f-]{36}$' then substring(topic from 6)::uuid else null end;
$$;

create policy "the team hears its channel" on realtime.messages
  for select to authenticated
  using (public.is_team(public.topic_table_id(realtime.topic())));

create policy "the team shows presence on its channel" on realtime.messages
  for insert to authenticated
  with check (realtime.messages.extension = 'presence'
              and public.is_team(public.topic_table_id(realtime.topic())));
