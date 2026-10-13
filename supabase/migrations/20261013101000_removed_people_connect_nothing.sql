-- Someone taken off the table could still connect an AI. Taking a person off ended their connections, but a connect
-- code they had made in the fifteen minutes before stayed good, and pairing never looked at whether its person was
-- still at the table. The AI connected that way was then handed the team's chat with every question asked. Now:
-- taking a person off spends their unused codes, pairing refuses a person who is no longer at the table, and a
-- connection whose person is gone is refused whatever token it holds.

create or replace function public.remove_member(m uuid)
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
  -- A connect code they made and have not used yet connects nothing now.
  update public.pairings set used_at = now() where member_id = m and used_at is null;
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

create or replace function public.pair_connection(code text, device_label text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.pairings;
  token text;
  conn uuid;
  who public.members;
  tname text;
  general uuid;
begin
  select * into p from public.pairings
    where code_hash = encode(extensions.digest(upper(btrim(code)), 'sha256'), 'hex')
    for update;
  if not found or p.used_at is not null or p.expires_at < now() then
    raise exception 'this connect code is not valid any more; press Connect again';
  end if;
  select * into who from public.members where id = p.member_id;
  if who.removed_at is not null then
    raise exception 'this connect code is not valid any more; press Connect again';
  end if;
  update public.pairings set used_at = now() where id = p.id;
  update public.connections set revoked_at = now()
    where member_id = p.member_id and revoked_at is null;
  token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.connections (table_id, member_id, kind, token_hash, label, last_seen)
    values (p.table_id, p.member_id, p.kind, encode(extensions.digest(token, 'sha256'), 'hex'), left(btrim(coalesce(device_label, '')), 80), now())
    returning id into conn;
  select name into tname from public.tables where id = p.table_id;
  select id into general from public.chats where table_id = p.table_id and is_general;
  if who.role <> 'client' then
    -- Reconnecting is not arriving: an AI that introduced itself here in the last week is not asked to again.
    if not exists (select 1 from public.messages mm where mm.table_id = p.table_id and mm.member_id = p.member_id and mm.kind = 'intro'
                    and mm.created_at > now() - interval '7 days') then
      insert into public.jobs (table_id, chat_id, member_id, kind) values (p.table_id, general, p.member_id, 'intro');
    end if;
  end if;
  perform public.log_activity(p.table_id, p.member_id, 'connection.paired', conn, jsonb_build_object('kind', p.kind, 'name', who.display_name));
  return jsonb_build_object('token', token, 'table_id', p.table_id, 'table_name', tname,
    'member_id', p.member_id, 'member_name', who.display_name, 'kind', p.kind, 'role', who.role);
end;
$$;

create or replace function public.connection_for(token text)
returns public.connections language plpgsql security definer set search_path = '' as $$
declare
  c public.connections;
begin
  select * into c from public.connections
    where token_hash = encode(extensions.digest(token, 'sha256'), 'hex') and revoked_at is null;
  if not found or exists (select 1 from public.members m where m.id = c.member_id and m.removed_at is not null) then
    raise exception 'this connection was removed; connect again from Longtable';
  end if;
  update public.connections set last_seen = now() where id = c.id;
  return c;
end;
$$;
