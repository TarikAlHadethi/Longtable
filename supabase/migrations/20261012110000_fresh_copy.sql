-- A copy is given clean. Changes the owner tried while setting it up ("Try a change yourself first") stayed in the
-- copy the client was then given. Giving it now puts the copy back to the product as it stands first.

CREATE OR REPLACE FUNCTION public.set_client_sandbox(m uuid, enabled boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  who public.members;
  seat uuid;
begin
  select * into who from public.members where id = m and removed_at is null;
  if not found or not public.is_owner(who.table_id) then
    raise exception 'only the owner decides what a client can do';
  end if;
  if who.role <> 'client' then
    raise exception 'a sandbox is for a client';
  end if;
  if enabled and not exists (select 1 from public.sandboxes s where s.member_id = m and s.url is not null) then
    raise exception 'set the copy up first: it needs an address to open at';
  end if;
  insert into public.sandboxes (member_id, table_id, mode, branch)
    values (m, who.table_id, case when enabled then 'sandbox' else 'chat' end, 'longtable/sandbox-'
      || coalesce(nullif(btrim(left(regexp_replace(lower(who.display_name), '[^a-z0-9]+', '-', 'g'), 30), '-'), ''), 'client')
      || '-' || left(m::text, 8))
    on conflict (member_id) do update set mode = excluded.mode;
  insert into public.table_sandbox (table_id) values (who.table_id) on conflict (table_id) do nothing;
  -- What the owner tried in the copy while setting it up is not the client's: the copy goes back to the product as
  -- it stands before it is theirs. The connection does it, with no AI asked anything.
  if enabled and exists (select 1 from public.sandbox_changes c where c.member_id = m and c.test and c.status = 'ready')
     and not exists (select 1 from public.sandbox_changes c where c.member_id = m and not c.test) then
    select cn.member_id into seat
      from public.connections cn join public.members mm on mm.id = cn.member_id and mm.role in ('owner', 'developer')
     where cn.table_id = who.table_id and cn.revoked_at is null and cn.kind = 'claude'
     order by (cn.last_seen > now() - interval '60 seconds') desc, (cn.member_id = public.final_seat_now(who.table_id)) desc, cn.created_at limit 1;
    if seat is not null then
      insert into public.jobs (table_id, member_id, kind, subject, brief) values (who.table_id, seat, 'sandbox', m, 'fresh');
    end if;
  end if;
  -- The client's page hears that what it can do has changed.
  perform realtime.send(jsonb_build_object('table', 'sandbox_changes', 'record', jsonb_build_object('id', m, 'status', 'mode')),
    'UPDATE', 'client:' || who.table_id::text || ':' || m::text, true);
  perform public.log_activity(who.table_id, public.my_member_id(who.table_id), case when enabled then 'sandbox.given' else 'sandbox.taken' end, m,
    jsonb_build_object('name', who.display_name));
end;
$function$;

CREATE OR REPLACE FUNCTION public.sandbox_job_payload(j jobs)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ch public.sandbox_changes;
  who public.members;
begin
  if j.change_id is null then
    -- Only the place is being made: the branch, pushed as it stands, so the hosting puts it up.
    return jsonb_build_object('job_id', j.id, 'kind', 'sandbox', 'probe', true, 'fresh', coalesce(j.brief = 'fresh', false),
      'table_name', (select name from public.tables where id = j.table_id),
      'me', (select display_name from public.members where id = j.member_id),
      'branch', (select s.branch from public.sandboxes s where s.member_id = j.subject));
  end if;
  select * into ch from public.sandbox_changes where id = j.change_id;
  select * into who from public.members where id = ch.member_id;
  return jsonb_build_object(
    'job_id', j.id,
    'kind', 'sandbox',
    'table_name', (select name from public.tables where id = j.table_id),
    'me', (select display_name from public.members where id = j.member_id),
    'client', who.display_name,
    'words', ch.words,
    'test', ch.test,
    'branch', (select s.branch from public.sandboxes s where s.member_id = ch.member_id),
    'paths', coalesce((select ts.paths from public.table_sandbox ts where ts.table_id = j.table_id), ''),
    'earlier', (select coalesce(jsonb_agg(jsonb_build_object('words', left(c.words, 600), 'summary', left(coalesce(c.summary, ''), 400), 'status', c.status,
                  'verdict', c.verdict, 'note', c.note) order by c.created_at), '[]'::jsonb)
                  from (select * from public.sandbox_changes x where x.member_id = ch.member_id and x.id <> ch.id and x.status <> 'working'
                         order by x.created_at desc limit 12) c));
end;
$function$;
