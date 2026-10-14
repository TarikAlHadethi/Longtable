-- Deleting a chat deleted the decisions in it, and a client's request that one of them was deciding stayed "being
-- decided" for ever, with nothing deciding it. It goes back to waiting for the team now. A question already sent to
-- the client stays theirs to answer, as before. The chat is held for the whole deletion, so a decision made in it at
-- the same moment cannot slip past and leave its request stuck the same way, and its decisions are held before any
-- request, in the same order as the clock that delivers them, so a deletion and a delivery never deadlock. Found by
-- the chaos run (rule D3).

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
