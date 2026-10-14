-- A client taken off the table was still being answered. Taking them off skipped only the jobs that were theirs to
-- run, not the jobs the team's AIs run ABOUT them (jobs.subject): a question of theirs the team's assistant had in
-- hand, and work on their copy. Finished after the removal, that answer was written into the removed client's chat,
-- and a pass-on put a new request and a client message in the team's chat in their name. Found by the chaos run
-- (tests/e2e/chaos-db.mjs, rule P4). The team could also still try changes on a removed client's copy.

CREATE OR REPLACE FUNCTION public.remove_member(m uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- A client taken off is not answered any more either: a question of theirs a team AI is answering, and work on
  -- their copy, stop with them, or the answer still landed in their chat and passed a request on in their name.
  update public.jobs set status = 'skipped', lease_until = null, error = 'taken off the table'
   where subject = m and status in ('queued', 'running', 'waiting');
  update public.tables set final_seat = null where id = who.table_id and final_seat = m;
  if who.role = 'client' then
    perform realtime.send(jsonb_build_object('table', 'members', 'record', jsonb_build_object('id', m, 'removed_at', now())),
      'UPDATE', 'client:' || who.table_id::text || ':' || m::text, true);
  end if;
  perform public.log_activity(who.table_id, public.my_member_id(who.table_id), 'member.removed', m,
    jsonb_build_object('name', who.display_name, 'role', who.role));
end;
$function$;

CREATE OR REPLACE FUNCTION public.team_sandbox_change(m uuid, body text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  sb public.sandboxes;
  words text := btrim(coalesce(body, ''));
  seat uuid;
  change uuid;
begin
  select * into sb from public.sandboxes where member_id = m;
  if not found or not public.is_team(sb.table_id) or not exists (select 1 from public.members x where x.id = m and x.removed_at is null) then
    raise exception 'that copy is not yours to try';
  end if;
  if char_length(words) = 0 or char_length(words) > 4000 then
    raise exception 'say what to change, in up to 4,000 characters';
  end if;
  if (select count(*) from public.sandbox_changes c where c.member_id = m and c.test and c.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'that is a lot of tests in one hour';
  end if;
  select cn.member_id into seat
    from public.connections cn join public.members mem on mem.id = cn.member_id and mem.role in ('owner', 'developer')
   where cn.table_id = sb.table_id and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
   order by (cn.member_id = public.my_member_id(sb.table_id)) desc, cn.created_at limit 1;
  if seat is null then
    raise exception 'connect your team''s Claude first';
  end if;
  insert into public.sandbox_changes (table_id, member_id, words, test) values (sb.table_id, m, words, true) returning id into change;
  insert into public.jobs (table_id, member_id, kind, change_id) values (sb.table_id, seat, 'sandbox', change);
  return change;
end;
$function$;
