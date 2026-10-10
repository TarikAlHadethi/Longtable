-- Step 6: the owner's settings and the people at a table. The owner names the table, sets the undo window, picks
-- who writes the final answer and where client requests land, invites people by name, and takes people off the
-- table. A person taken off keeps their history (their messages stay, signed with their name) but loses all access
-- at once: every rule that asks "are you at this table" now also asks "and not taken off".

alter table public.members add column removed_at timestamptz;

create or replace function public.is_member(t uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m where m.table_id = t and m.user_id = auth.uid() and m.removed_at is null);
$$;

create or replace function public.is_team(t uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m
                 where m.table_id = t and m.user_id = auth.uid() and m.role in ('owner', 'developer') and m.removed_at is null);
$$;

create or replace function public.is_owner(t uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m
                 where m.table_id = t and m.user_id = auth.uid() and m.role = 'owner' and m.removed_at is null);
$$;

create or replace function public.my_member_id(t uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select m.id from public.members m where m.table_id = t and m.user_id = auth.uid() and m.removed_at is null;
$$;

-- The undo window has a floor: at 0 there is no window at all. Five seconds to 300 (decided 10 Oct).
alter table public.tables drop constraint tables_undo_seconds_check;
alter table public.tables add constraint tables_undo_seconds_check check (undo_seconds between 5 and 300);

-- An invite can carry the person's name and email, so their join page is already filled in.
alter table public.invites add column name text not null default '' check (char_length(name) <= 60);
alter table public.invites add column email text not null default '' check (char_length(email) <= 200);

drop function public.create_invite(uuid, public.member_role);
create function public.create_invite(t uuid, invite_role public.member_role, invite_name text default '', invite_email text default '')
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
$$;
revoke all on function public.create_invite(uuid, public.member_role, text, text) from public, anon;
grant execute on function public.create_invite(uuid, public.member_role, text, text) to authenticated;

drop function public.invite_preview(text);
create function public.invite_preview(token text)
returns table (table_name text, role public.member_role, expired boolean, used boolean, name text)
language sql stable security definer set search_path = '' as $$
  select t.name, i.role, i.expires_at < now(), i.used_at is not null, i.name
  from public.invites i
  join public.tables t on t.id = i.table_id
  where i.token_hash = encode(extensions.digest(token, 'sha256'), 'hex');
$$;
revoke all on function public.invite_preview(text) from public;
grant execute on function public.invite_preview(text) to anon, authenticated;

-- Accepting: someone at the table gets it back; someone taken off comes back only through a new invite.
create or replace function public.accept_invite(token text, my_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
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
  words := coalesce(nullif(btrim(coalesce(my_name, '')), ''), nullif(inv.name, ''));
  if words is null then
    raise exception 'add your name';
  end if;
  if was.id is not null then
    update public.members set removed_at = null, role = inv.role, display_name = left(words, 60) where id = was.id
      returning id into me;
  else
    insert into public.members (table_id, user_id, role, display_name, color)
      values (inv.table_id, auth.uid(), inv.role, left(words, 60), public.next_color(inv.table_id)) returning id into me;
  end if;
  update public.invites set used_by = auth.uid(), used_at = now() where id = inv.id;
  perform public.log_activity(inv.table_id, me, 'member.joined', me, jsonb_build_object('role', inv.role, 'name', left(words, 60)));
  return inv.table_id;
end;
$$;

-- The table's own settings. Only the owner changes them.
create function public.update_table(t uuid, table_name text, undo integer, requests_chat uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_owner(t) then
    raise exception 'only the owner changes the settings';
  end if;
  if char_length(btrim(coalesce(table_name, ''))) not between 1 and 80 then
    raise exception 'the table needs a name of up to 80 characters';
  end if;
  if undo is null or undo not between 5 and 300 then
    raise exception 'the undo window is 5 to 300 seconds';
  end if;
  if requests_chat is not null and not exists (select 1 from public.chats c where c.id = requests_chat and c.table_id = t) then
    raise exception 'that chat is not at this table';
  end if;
  update public.tables set name = btrim(table_name), undo_seconds = undo, client_chat = requests_chat where id = t;
  perform public.log_activity(t, public.my_member_id(t), 'settings.changed', t,
    jsonb_build_object('name', btrim(table_name), 'undo_seconds', undo, 'client_chat', requests_chat));
end;
$$;
revoke all on function public.update_table(uuid, text, integer, uuid) from public, anon;
grant execute on function public.update_table(uuid, text, integer, uuid) to authenticated;

-- Taking someone off the table: their access ends at once, their AI is disconnected and its waiting work dropped.
-- Their messages stay, under their name. The owner cannot take themselves off.
create function public.remove_member(m uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  who public.members;
begin
  select * into who from public.members where id = m;
  if not found or not public.is_owner(who.table_id) then
    raise exception 'only the owner takes people off the table';
  end if;
  if who.role = 'owner' then
    raise exception 'the owner cannot be taken off';
  end if;
  if who.removed_at is not null then
    return;
  end if;
  update public.members set removed_at = now() where id = m;
  update public.connections set revoked_at = now() where member_id = m and revoked_at is null;
  update public.jobs set status = 'skipped', lease_until = null, error = 'taken off the table'
   where member_id = m and status in ('queued', 'running', 'waiting');
  update public.tables set final_seat = null where id = who.table_id and final_seat = m;
  if who.role = 'client' then
    perform realtime.send(jsonb_build_object('table', 'members', 'record', jsonb_build_object('id', m, 'removed_at', now())),
      'UPDATE', 'client:' || who.table_id::text || ':' || m::text, true);
  end if;
  perform public.log_activity(who.table_id, public.my_member_id(who.table_id), 'member.removed', m,
    jsonb_build_object('name', who.display_name, 'role', who.role));
end;
$$;
revoke all on function public.remove_member(uuid) from public, anon;
grant execute on function public.remove_member(uuid) to authenticated;
