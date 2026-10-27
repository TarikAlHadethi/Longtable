-- Joining a table with its code, and locking a table.
--
-- Until now the only way in was a one-time invite link, so someone who signed up on their own landed nowhere. Every
-- table now has a short code its owners keep (Settings, People). Someone signed in types it in, says their name, and
-- waits: the table's owners see them asking and let them in as a developer or a client, or say no. Nothing about the
-- table is shown to anyone with a wrong code, wrong codes are limited per person, and an owner can make a new code
-- whenever the old one went too far.
--
-- A locked table takes nobody new: no code works, no invite link can be made, and an invite link already sent stops
-- working. People already at the table are not touched.

create table public.table_joining (
  table_id uuid primary key references public.tables(id) on delete cascade,
  code text not null unique check (code ~ '^[A-Z2-9]{8}$'),
  locked boolean not null default false,
  made_at timestamptz not null default now()
);
alter table public.table_joining enable row level security;
-- Read only through joining(): nobody reads the codes table itself, owners included.

create table public.join_requests (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  email text not null default '',
  note text not null default '' check (char_length(note) <= 200),
  status text not null default 'waiting' check (status in ('waiting', 'in', 'no', 'cancelled')),
  role public.member_role,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid
);
create unique index join_requests_one_waiting on public.join_requests (table_id, user_id) where status = 'waiting';
create index join_requests_user on public.join_requests (user_id, created_at desc);
alter table public.join_requests enable row level security;
create policy join_requests_read on public.join_requests for select to authenticated
  using (user_id = auth.uid() or public.is_owner(table_id));
grant select on public.join_requests to authenticated;

-- Wrong codes, so nobody can try their way into a table.
create table public.join_tries (
  user_id uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now()
);
create index join_tries_user on public.join_tries (user_id, at desc);
alter table public.join_tries enable row level security;

-- Eight letters and digits a person can read out loud: no 0, O, 1, I or L.
create function public.new_code() returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  abc constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  raw bytea;
  c text;
begin
  loop
    raw := extensions.gen_random_bytes(8);
    c := '';
    for i in 0..7 loop
      c := c || substr(abc, 1 + (get_byte(raw, i) % 31), 1);
    end loop;
    exit when not exists (select 1 from public.table_joining where code = c);
  end loop;
  return c;
end;
$$;
revoke all on function public.new_code() from public, anon, authenticated;

-- The owners' view of joining: the code (made the first time it is asked for) and whether the table is locked.
create function public.joining(t uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  j public.table_joining;
begin
  if not public.is_owner(t) then raise exception 'only an owner sees the table code'; end if;
  insert into public.table_joining (table_id, code) values (t, public.new_code()) on conflict (table_id) do nothing;
  select * into j from public.table_joining where table_id = t;
  return jsonb_build_object('code', j.code, 'locked', j.locked, 'made_at', j.made_at);
end;
$$;

-- A new code: the old one stops working at once. Requests already waiting stay.
create function public.new_join_code(t uuid) returns text language plpgsql security definer set search_path = '' as $$
declare
  c text := public.new_code();
begin
  if not public.is_owner(t) then raise exception 'only an owner changes the table code'; end if;
  insert into public.table_joining (table_id, code) values (t, c)
    on conflict (table_id) do update set code = excluded.code, made_at = now();
  perform public.log_activity(t, public.my_member_id(t), 'join.new_code', null, '{}'::jsonb);
  return c;
end;
$$;

create function public.set_table_locked(t uuid, on_ boolean) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_owner(t) then raise exception 'only an owner locks the table'; end if;
  insert into public.table_joining (table_id, code, locked) values (t, public.new_code(), on_)
    on conflict (table_id) do update set locked = excluded.locked;
  perform public.log_activity(t, public.my_member_id(t), 'table.locked', null, jsonb_build_object('locked', on_));
end;
$$;

create function public.table_is_locked(t uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select locked from public.table_joining where table_id = t), false);
$$;
revoke all on function public.table_is_locked(uuid) from public, anon;
grant execute on function public.table_is_locked(uuid) to authenticated;

-- Someone signed in asks to join with a code. Says only what they need: the table's name once the code is right.
create function public.ask_to_join(code text, my_name text, note text default '') returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare
  c text := upper(regexp_replace(coalesce(code, ''), '[^A-Za-z0-9]', '', 'g'));
  j public.table_joining;
  tname text;
  was public.members;
  r public.join_requests;
  words text := left(btrim(coalesce(my_name, '')), 60);
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if (select count(*) from public.join_tries where user_id = auth.uid() and at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many wrong codes. Try again in an hour.';
  end if;
  select * into j from public.table_joining where table_joining.code = c;
  if not found then
    -- Answered, not raised: raising would undo the record of this try along with everything else.
    insert into public.join_tries (user_id) values (auth.uid());
    return jsonb_build_object('status', 'wrong');
  end if;
  select name into tname from public.tables where id = j.table_id;
  select * into was from public.members m where m.table_id = j.table_id and m.user_id = auth.uid();
  if found and was.removed_at is null then
    return jsonb_build_object('status', 'member', 'table_id', j.table_id, 'table_name', tname);
  end if;
  if j.locked then raise exception '% is not taking new people right now.', tname; end if;
  select * into r from public.join_requests where table_id = j.table_id and user_id = auth.uid() and status = 'waiting';
  if found then
    return jsonb_build_object('status', 'waiting', 'table_id', j.table_id, 'table_name', tname, 'request', r.id);
  end if;
  if exists (select 1 from public.join_requests where table_id = j.table_id and user_id = auth.uid() and status = 'no'
             and decided_at > now() - interval '7 days') then
    raise exception 'The owners of % did not let you in. Ask one of them directly.', tname;
  end if;
  if words = '' then raise exception 'add your name'; end if;
  if (select count(*) from public.join_requests where user_id = auth.uid() and status = 'waiting') >= 5 then
    raise exception 'You are already waiting on five tables. Cancel one first.';
  end if;
  if (select count(*) from public.join_requests where table_id = j.table_id and status = 'waiting') >= 50 then
    raise exception '% has too many people waiting. Ask an owner to answer them first.', tname;
  end if;
  insert into public.join_requests (table_id, user_id, name, email, note)
    values (j.table_id, auth.uid(), words, coalesce((select email from auth.users where id = auth.uid()), ''),
            left(btrim(coalesce(note, '')), 200))
    returning * into r;
  perform public.log_activity(j.table_id, null, 'join.asked', r.id, jsonb_build_object('name', words));
  return jsonb_build_object('status', 'waiting', 'table_id', j.table_id, 'table_name', tname, 'request', r.id);
end;
$$;

-- What the person asking sees: their own requests of the last month, with the table's name.
create function public.my_join_requests() returns table (id uuid, table_id uuid, table_name text, status text, created_at timestamptz)
  language sql stable security definer set search_path = '' as $$
  select r.id, r.table_id, t.name, r.status, r.created_at
    from public.join_requests r join public.tables t on t.id = r.table_id
   where r.user_id = auth.uid() and r.status <> 'cancelled' and r.created_at > now() - interval '30 days'
   order by r.created_at desc limit 20;
$$;

create function public.cancel_join(r uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.join_requests set status = 'cancelled', decided_at = now()
   where id = r and user_id = auth.uid() and status = 'waiting';
end;
$$;

-- An owner lets them in, as a developer or a client, or says no.
create function public.answer_join(r uuid, let_in boolean, as_role public.member_role default 'developer') returns void
  language plpgsql security definer set search_path = '' as $$
declare
  q public.join_requests;
  was public.members;
  me uuid;
begin
  select * into q from public.join_requests where id = r for update;
  if not found or not public.is_owner(q.table_id) then raise exception 'only an owner answers this'; end if;
  if q.status <> 'waiting' then raise exception 'someone already answered this'; end if;
  if not let_in then
    update public.join_requests set status = 'no', decided_at = now(), decided_by = public.my_member_id(q.table_id) where id = r;
    perform public.log_activity(q.table_id, public.my_member_id(q.table_id), 'join.answered', r, jsonb_build_object('name', q.name, 'in', false));
    return;
  end if;
  if as_role not in ('developer', 'client') then raise exception 'let them in as a developer, then make them a co-owner'; end if;
  if public.table_is_locked(q.table_id) then raise exception 'the table is locked: unlock it first'; end if;
  -- Locked in the same order as remove_member and transfer_ownership: the table first.
  perform 1 from public.tables where id = q.table_id for update;
  select * into was from public.members m where m.table_id = q.table_id and m.user_id = q.user_id;
  if found and was.removed_at is null then
    me := was.id;
  elsif found then
    update public.members set removed_at = null, role = as_role, can_settings = false, can_invite = false, can_clients = false,
           display_name = q.name,
           bubble = case when exists (select 1 from public.members o where o.table_id = was.table_id and o.bubble = was.bubble
           and o.id <> was.id and o.removed_at is null) then public.free_bubble(was.table_id) else bubble end
     where id = was.id returning id into me;
  else
    insert into public.members (table_id, user_id, role, display_name, color)
      values (q.table_id, q.user_id, as_role, q.name, public.next_color(q.table_id)) returning id into me;
  end if;
  update public.join_requests set status = 'in', role = as_role, decided_at = now(), decided_by = public.my_member_id(q.table_id) where id = r;
  perform public.log_activity(q.table_id, me, 'member.joined', me, jsonb_build_object('role', as_role, 'name', q.name, 'code', true));
end;
$$;

-- Owners hear at once that someone is asking or was answered: only the id goes out, their screens read the rest.
create function public.broadcast_join_request() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(jsonb_build_object('table', 'join_requests', 'record', jsonb_build_object('id', new.id)),
    tg_op, 'team:' || new.table_id::text, true);
  return null;
end;
$$;
create trigger join_requests_broadcast after insert or update on public.join_requests
  for each row execute function public.broadcast_join_request();

revoke all on function public.joining(uuid) from public, anon;
revoke all on function public.new_join_code(uuid) from public, anon;
revoke all on function public.set_table_locked(uuid, boolean) from public, anon;
revoke all on function public.ask_to_join(text, text, text) from public, anon;
revoke all on function public.my_join_requests() from public, anon;
revoke all on function public.cancel_join(uuid) from public, anon;
revoke all on function public.answer_join(uuid, boolean, public.member_role) from public, anon;
revoke all on function public.broadcast_join_request() from public, anon, authenticated;
grant execute on function public.joining(uuid) to authenticated;
grant execute on function public.new_join_code(uuid) to authenticated;
grant execute on function public.set_table_locked(uuid, boolean) to authenticated;
grant execute on function public.ask_to_join(text, text, text) to authenticated;
grant execute on function public.my_join_requests() to authenticated;
grant execute on function public.cancel_join(uuid) to authenticated;
grant execute on function public.answer_join(uuid, boolean, public.member_role) to authenticated;

-- A locked table makes no invite links and takes none already sent.
CREATE OR REPLACE FUNCTION public.create_invite(t uuid, invite_role member_role, invite_name text DEFAULT ''::text, invite_email text DEFAULT ''::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  raw text;
  inv uuid;
begin
  if not public.may(t, 'invite') then
    raise exception 'only the owner can invite';
  end if;
  if public.table_is_locked(t) then
    raise exception 'This table is locked. An owner can unlock it in Settings, People.';
  end if;
  if invite_role = 'owner' then
    raise exception 'invite them as a developer, then make them a co-owner';
  end if;
  if btrim(coalesce(invite_email, '')) <> '' and btrim(invite_email) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'that email does not look right';
  end if;
  raw := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.invites (table_id, role, token_hash, created_by, name, email)
    values (t, invite_role, encode(extensions.digest(raw, 'sha256'), 'hex'), auth.uid(),
            left(btrim(coalesce(invite_name, '')), 60), left(lower(btrim(coalesce(invite_email, ''))), 200))
    returning id into inv;
  perform public.log_activity(t, public.my_member_id(t), 'invite.created', inv,
    jsonb_build_object('role', invite_role, 'name', left(btrim(coalesce(invite_name, '')), 60)));
  return raw;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.accept_invite(token text, my_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  inv public.invites;
  me uuid;
  was public.members;
  words text;
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
  select * into was from public.members m where m.table_id = inv.table_id and m.user_id = auth.uid();
  if found and was.removed_at is null then
    return inv.table_id;
  end if;
  if inv.used_at is not null then
    raise exception 'this invite link was already used';
  end if;
  if inv.expires_at < now() then
    raise exception 'this invite link has expired';
  end if;
  if public.table_is_locked(inv.table_id) then
    raise exception 'this table is not taking new people right now';
  end if;
  words := coalesce(nullif(btrim(coalesce(my_name, '')), ''), nullif(inv.name, ''));
  if words is null then
    raise exception 'add your name';
  end if;
  if was.id is not null then
    -- Their bubble colour may have gone to someone else while they were away: then they get a free one.
    update public.members set removed_at = null, role = inv.role, can_settings = false, can_invite = false, can_clients = false, display_name = left(words, 60),
           bubble = case when exists (select 1 from public.members o where o.table_id = was.table_id and o.bubble = was.bubble
           and o.id <> was.id and o.removed_at is null) then public.free_bubble(was.table_id) else bubble end
     where id = was.id
      returning id into me;
  else
    insert into public.members (table_id, user_id, role, display_name, color)
      values (inv.table_id, auth.uid(), inv.role, left(words, 60), public.next_color(inv.table_id)) returning id into me;
  end if;
  update public.invites set used_by = auth.uid(), used_at = now() where id = inv.id;
  perform public.log_activity(inv.table_id, me, 'member.joined', me, jsonb_build_object('role', inv.role, 'name', left(words, 60)));
  -- Someone let in by a link no longer waits on the code: their request is answered.
  update public.join_requests set status = 'in', role = inv.role, decided_at = now()
   where table_id = inv.table_id and user_id = auth.uid() and status = 'waiting';
  return inv.table_id;
end;
$function$
;
