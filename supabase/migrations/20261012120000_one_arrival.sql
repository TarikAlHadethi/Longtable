-- An AI joins a table once. Disconnecting and connecting again made it read the project and announce itself every
-- time, which cost a run of the person's model and filled the chat with "joined the table" lines.

CREATE OR REPLACE FUNCTION public.pair_connection(code text, device_label text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  update public.pairings set used_at = now() where id = p.id;
  update public.connections set revoked_at = now()
    where member_id = p.member_id and revoked_at is null;
  token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.connections (table_id, member_id, kind, token_hash, label, last_seen)
    values (p.table_id, p.member_id, p.kind, encode(extensions.digest(token, 'sha256'), 'hex'), left(btrim(coalesce(device_label, '')), 80), now())
    returning id into conn;
  select * into who from public.members where id = p.member_id;
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
$function$;
