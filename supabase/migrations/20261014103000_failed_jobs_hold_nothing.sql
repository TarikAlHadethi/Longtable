-- A job failed by disconnecting its AI, or by a connection that never finished setting up, kept its lease and had no
-- finish time, so it still looked taken and unfinished to anything that reads those. Now it is let go and finished
-- like every other failed job. Found by the chaos run (rule E7: a job's fields agree with its status).

CREATE OR REPLACE FUNCTION public.disconnect(conn uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    update public.jobs set status = 'failed', error = 'its AI was disconnected', lease_until = null, finished_at = now()
     where member_id = cn.member_id and status in ('queued', 'running', 'waiting');
  end if;
  perform public.log_activity(cn.table_id, public.my_member_id(cn.table_id), 'connection.removed', conn, jsonb_build_object('kind', cn.kind));
end;
$function$;

CREATE OR REPLACE FUNCTION public.runner_leave(token text, reason text DEFAULT ''::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.connections := public.connection_for(token);
begin
  update public.connections set revoked_at = now() where id = c.id and revoked_at is null;
  update public.jobs set status = 'failed', lease_until = null, finished_at = now(), error = left(coalesce(nullif(btrim(reason), ''), 'the connection did not finish setting up'), 300)
   where member_id = c.member_id and kind = 'intro' and status in ('queued', 'running');
  perform public.log_activity(c.table_id, c.member_id, 'connection.removed', c.id, jsonb_build_object('kind', c.kind, 'setup_failed', true));
end;
$function$;
