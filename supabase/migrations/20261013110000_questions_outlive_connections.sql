-- A client's question was dropped when the AI answering it went away. Disconnecting an AI, or taking its person off
-- the table, marked its open jobs failed or skipped directly, and the step that passes an unanswered question on to
-- the team only looks at jobs still queued or running. The client's line then sat with no answer and the team never
-- saw it. Both now pass such a question on first, the way a timeout does.

CREATE OR REPLACE FUNCTION public.disconnect(conn uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  cn public.connections;
begin
  select * into cn from public.connections where id = conn for update;
  if not found or not (cn.member_id = public.my_member_id(cn.table_id) or public.is_owner(cn.table_id)) then
    raise exception 'not yours to disconnect';
  end if;
  update public.connections set revoked_at = now() where id = conn and revoked_at is null;
  -- Nothing of theirs is left looking busy, unless another connection of theirs is still on.
  if not exists (select 1 from public.connections x where x.member_id = cn.member_id and x.revoked_at is null) then
    -- A client's question it was answering is passed on to the team, not dropped with the connection.
    perform public.give_up_client_job(j.id, 'its AI was disconnected')
       from public.jobs j where j.member_id = cn.member_id and j.kind = 'client' and j.status in ('queued', 'running');
    update public.jobs set status = 'failed', error = 'its AI was disconnected'
     where member_id = cn.member_id and status in ('queued', 'running', 'waiting');
  end if;
  perform public.log_activity(cn.table_id, public.my_member_id(cn.table_id), 'connection.removed', conn, jsonb_build_object('kind', cn.kind));
end;
$$;

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
  -- A client's question their AI was answering for the team is passed on to the team, not dropped with them.
  if who.role <> 'client' then
    perform public.give_up_client_job(j.id, 'taken off the table')
       from public.jobs j where j.member_id = m and j.kind = 'client' and j.status in ('queued', 'running');
  end if;
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
