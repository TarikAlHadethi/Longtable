-- A connection that could not finish setting up (it could not fetch the code, or the sign-in was not approved)
-- takes itself off the table again, so nobody sees an AI as connected that is not running.

create function public.runner_leave(token text, reason text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
begin
  update public.connections set revoked_at = now() where id = c.id and revoked_at is null;
  update public.jobs set status = 'failed', error = left(coalesce(nullif(btrim(reason), ''), 'the connection did not finish setting up'), 300)
   where member_id = c.member_id and kind = 'intro' and status in ('queued', 'running');
  perform public.log_activity(c.table_id, c.member_id, 'connection.removed', c.id, jsonb_build_object('kind', c.kind, 'setup_failed', true));
end;
$$;
revoke all on function public.runner_leave(text, text) from public;
grant execute on function public.runner_leave(text, text) to anon, authenticated;
