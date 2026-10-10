-- Renaming and deleting a chat. Anyone on the team may rename one. Deleting takes its messages and decisions with
-- it, so only the owner or the person who made the chat may do it, and never the General chat.

create function public.rename_chat(c uuid, chat_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  ch public.chats;
  clean text := left(btrim(coalesce(chat_name, '')), 60);
begin
  select * into ch from public.chats where id = c;
  if not found or not public.is_team(ch.table_id) then
    raise exception 'only the team can rename a chat';
  end if;
  if clean = '' then
    raise exception 'a chat needs a name';
  end if;
  update public.chats set name = clean where id = c;
  perform public.log_activity(ch.table_id, public.my_member_id(ch.table_id), 'chat.renamed', c, jsonb_build_object('from', ch.name, 'name', clean));
end;
$$;

create function public.delete_chat(c uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  ch public.chats;
  me uuid;
begin
  select * into ch from public.chats where id = c;
  if not found or not public.is_team(ch.table_id) then
    raise exception 'only the team can delete a chat';
  end if;
  me := public.my_member_id(ch.table_id);
  if ch.is_general then
    raise exception 'the General chat stays';
  end if;
  if not (public.is_owner(ch.table_id) or ch.created_by = me) then
    raise exception 'only the owner or the person who made this chat can delete it';
  end if;
  delete from public.chats where id = c;
  perform public.log_activity(ch.table_id, me, 'chat.deleted', c, jsonb_build_object('name', ch.name));
  -- Everyone at the table sees it go.
  perform realtime.send(jsonb_build_object('table', 'chats', 'record', jsonb_build_object('id', c, 'deleted', true)),
    'UPDATE', 'team:' || ch.table_id::text, true);
end;
$$;

revoke all on function public.rename_chat(uuid, text), public.delete_chat(uuid) from public, anon;
grant execute on function public.rename_chat(uuid, text), public.delete_chat(uuid) to authenticated;
