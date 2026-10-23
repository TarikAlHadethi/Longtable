-- A client's copy lands where the team's hosting builds it: the table's repository. A copy set up while the Claude that
-- keeps it has not said yes to that repository (or connected with it) would only ever land in a folder on one
-- computer, where no hosting sees it, and the setup would wait for an address that never comes. Now it is refused in
-- plain words, saying what to press. (The connection refuses the same push itself.)

create or replace function public.same_repo(a text, b text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(regexp_replace(lower(btrim(a)), '(\.git)?/*$', '') = regexp_replace(lower(btrim(b)), '(\.git)?/*$', ''), false);
$$;

CREATE OR REPLACE FUNCTION public.prepare_client_sandbox(m uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  who public.members;
  seat uuid;
  name text;
  repo text;
begin
  select * into who from public.members where id = m and removed_at is null;
  if not found or not public.may(who.table_id, 'clients') then
    raise exception 'only the owner sets a copy up';
  end if;
  if who.role <> 'client' then
    raise exception 'a copy is for a client';
  end if;
  select cn.member_id into seat
    from public.connections cn join public.members mem on mem.id = cn.member_id and mem.role in ('owner', 'developer')
   where cn.table_id = who.table_id and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
   order by (cn.member_id = public.final_seat_now(who.table_id)) desc, cn.created_at limit 1;
  if seat is null then
    raise exception 'connect your team''s Claude first: it is what makes the copy';
  end if;
  select tc.repo_url into repo from public.table_code tc where tc.table_id = who.table_id;
  if repo is null then
    raise exception 'set where the code is first (Settings, General): a copy is a branch of the table''s repository, which your hosting builds';
  end if;
  if not exists (select 1 from public.connections cn where cn.member_id = seat and cn.revoked_at is null and cn.kind = 'claude'
                  and (public.same_repo(cn.use_repo, repo) or public.same_repo(cn.limits -> 'reads' ->> 'repo', repo))) then
    raise exception '%''s Claude has not said yes to %. In their AI window, press Use it, so the copy lands there, where your hosting builds it.',
      (select split_part(m.display_name, ' ', 1) from public.members m where m.id = seat), repo;
  end if;
  insert into public.sandboxes (member_id, table_id, mode, branch)
    values (m, who.table_id, 'chat', 'longtable/sandbox-'
      || coalesce(nullif(btrim(left(regexp_replace(lower(who.display_name), '[^a-z0-9]+', '-', 'g'), 30), '-'), ''), 'client')
      || '-' || left(m::text, 8))
    on conflict (member_id) do nothing;
  insert into public.table_sandbox (table_id) values (who.table_id) on conflict (table_id) do nothing;
  select s.branch into name from public.sandboxes s where s.member_id = m;
  if not exists (select 1 from public.jobs j where j.subject = m and j.kind = 'sandbox' and j.change_id is null and j.status in ('queued', 'running')) then
    insert into public.jobs (table_id, member_id, kind, subject) values (who.table_id, seat, 'sandbox', m);
  end if;
  return name;
end;
$function$

;

-- Connect 0.1.41: the connection refuses the same push itself.
update public.connect_release set version = '0.1.41', set_at = now();
