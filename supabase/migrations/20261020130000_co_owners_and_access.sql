-- Co-owners and what each teammate may change.
--
-- A table has one main owner (who started it, or was handed it) and may have co-owners: a co-owner can do everything
-- the main owner can, except delete the table, hand it over, or take the main owner or another owner off. Every
-- existing owner check already lets a co-owner through; only those three are the main owner's.
--
-- A developer can be given three things, each on or off, by an owner: the table's settings, inviting people, and
-- the clients (who answers them, their copy, taking a client off). Without them a developer changes none of it.

drop index if exists public.members_one_owner;

alter table public.tables add column main_owner uuid references public.members(id) on delete set null;
update public.tables t set main_owner = (select m.id from public.members m where m.table_id = t.id and m.role = 'owner' and m.removed_at is null order by m.created_at limit 1)
 where main_owner is null;

alter table public.members add column can_settings boolean not null default false,
  add column can_invite boolean not null default false,
  add column can_clients boolean not null default false;
grant select (can_settings, can_invite, can_clients) on public.members to authenticated;
grant select (main_owner) on public.tables to authenticated;

-- A new table's first owner is its main owner.
create function public.main_owner_first() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.role = 'owner' then
    update public.tables set main_owner = new.id where id = new.table_id and main_owner is null;
  end if;
  return null;
end;
$$;
create trigger members_main_owner after insert or update of role on public.members
  for each row execute function public.main_owner_first();

create function public.is_main_owner(t uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m join public.tables tb on tb.id = m.table_id and tb.main_owner = m.id
                 where m.table_id = t and m.user_id = auth.uid() and m.role = 'owner' and m.removed_at is null);
$$;

-- Whether the caller may change this part of the table: any owner, or a developer given it.
create function public.may(t uuid, what text) returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_owner(t) or exists (
    select 1 from public.members m where m.table_id = t and m.user_id = auth.uid() and m.role = 'developer' and m.removed_at is null
      and case what when 'settings' then m.can_settings when 'invite' then m.can_invite when 'clients' then m.can_clients else false end);
$$;
revoke all on function public.is_main_owner(uuid) from public, anon;
revoke all on function public.may(uuid, text) from public, anon;
grant execute on function public.is_main_owner(uuid) to authenticated;
grant execute on function public.may(uuid, text) to authenticated;

-- The main owner makes a developer a co-owner, or a co-owner a developer again.
create function public.set_co_owner(m uuid, co boolean) returns void language plpgsql security definer set search_path = '' as $$
declare
  who public.members;
begin
  select * into who from public.members where id = m;
  if not found then raise exception 'only the main owner makes co-owners'; end if;
  perform 1 from public.tables where id = who.table_id for update;
  select * into who from public.members where id = m for update;
  if not public.is_main_owner(who.table_id) then raise exception 'only the main owner makes co-owners'; end if;
  if who.removed_at is not null then raise exception 'they are not at the table'; end if;
  if exists (select 1 from public.tables where id = who.table_id and main_owner = who.id) then raise exception 'that is the main owner'; end if;
  if co and who.role <> 'developer' then raise exception 'only a developer can become a co-owner'; end if;
  if not co and who.role <> 'owner' then raise exception 'they are not a co-owner'; end if;
  update public.members set role = case when co then 'owner'::public.member_role else 'developer'::public.member_role end where id = m;
  perform public.log_activity(who.table_id, public.my_member_id(who.table_id), case when co then 'member.co_owner' else 'member.not_co_owner' end, m,
    jsonb_build_object('name', who.display_name));
end;
$$;
revoke all on function public.set_co_owner(uuid, boolean) from public, anon;
grant execute on function public.set_co_owner(uuid, boolean) to authenticated;

-- An owner turns a developer's three permissions on or off.
create function public.set_member_access(m uuid, settings boolean, invite boolean, clients boolean) returns void language plpgsql security definer set search_path = '' as $$
declare
  who public.members;
begin
  select * into who from public.members where id = m and removed_at is null;
  if not found or not public.is_owner(who.table_id) then raise exception 'only an owner changes what a teammate may do'; end if;
  if who.role <> 'developer' then raise exception 'only a developer''s access is set: owners have it all, clients none'; end if;
  update public.members set can_settings = coalesce(settings, can_settings), can_invite = coalesce(invite, can_invite),
    can_clients = coalesce(clients, can_clients) where id = m;
  perform public.log_activity(who.table_id, public.my_member_id(who.table_id), 'member.access', m,
    jsonb_build_object('name', who.display_name, 'settings', coalesce(settings, who.can_settings), 'invite', coalesce(invite, who.can_invite), 'clients', coalesce(clients, who.can_clients)));
end;
$$;
revoke all on function public.set_member_access(uuid, boolean, boolean, boolean) from public, anon;
grant execute on function public.set_member_access(uuid, boolean, boolean, boolean) to authenticated;

CREATE OR REPLACE FUNCTION public.update_table(t uuid, table_name text, undo integer, requests_chat uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.may(t, 'settings') then
    raise exception 'only the owner changes the settings';
  end if;
  if char_length(btrim(coalesce(table_name, ''))) not between 1 and 80 then
    raise exception 'the table needs a name of up to 80 characters';
  end if;
  if undo is null or undo not between 5 and 300 then
    raise exception 'the undo window is 5 to 300 seconds';
  end if;
  if requests_chat is not null and not exists (select 1 from public.chats c where c.id = requests_chat and c.table_id = t) then
    raise exception 'that chat is not at this table';
  end if;
  update public.tables set name = btrim(table_name), undo_seconds = undo, client_chat = requests_chat where id = t;
  perform public.log_activity(t, public.my_member_id(t), 'settings.changed', t,
    jsonb_build_object('name', btrim(table_name), 'undo_seconds', undo, 'client_chat', requests_chat));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_final_seat(t uuid, seat uuid, offline text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.may(t, 'settings') then
    raise exception 'only the owner changes who writes the final answer';
  end if;
  if seat is not null and not exists (select 1 from public.members where id = seat and table_id = t and role in ('owner', 'developer') and removed_at is null) then
    raise exception 'the final answer has to come from someone on the team';
  end if;
  if offline not in ('wait', 'next') then
    raise exception 'unknown choice';
  end if;
  update public.tables set final_seat = seat, when_final_offline = offline where id = t;
  perform public.log_activity(t, public.my_member_id(t), 'settings.final_seat', seat, jsonb_build_object('offline', offline));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.connect_github(t uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  raw text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not public.may(t, 'settings') then
    raise exception 'only the owner connects GitHub';
  end if;
  insert into public.github_hooks (table_id, secret) values (t, raw)
    on conflict (table_id) do update set secret = excluded.secret, repo = '', last_event_at = null;
  perform public.log_activity(t, public.my_member_id(t), 'github.connected', t, '{}'::jsonb);
  return raw;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.disconnect_github(t uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.may(t, 'settings') then
    raise exception 'only the owner disconnects GitHub';
  end if;
  delete from public.github_hooks where table_id = t;
  perform public.log_activity(t, public.my_member_id(t), 'github.disconnected', t, '{}'::jsonb);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_table_repo(t uuid, url text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  clean text := btrim(coalesce(url, ''));
begin
  if not public.may(t, 'settings') then
    raise exception 'only the team can say where the code is';
  end if;
  if clean = '' then
    delete from public.table_code where table_id = t;
  else
    if clean !~ '^(https://|ssh://|git@)[A-Za-z0-9@:/._~+-]{4,250}$' then
      raise exception 'that does not look like a repository address; it starts with https:// or git@';
    end if;
    -- A sign-in written into the address (https://name:token@...) would be kept and shown to the team: refused.
    if clean ~ '^(https|ssh)://[^/]*@' then
      raise exception 'that address has a sign-in in it; give it without the name or token before the @';
    end if;
    insert into public.table_code (table_id, repo_url) values (t, clean)
      on conflict (table_id) do update set repo_url = excluded.repo_url, updated_at = now();
  end if;
  perform public.log_activity(t, public.my_member_id(t), 'table.repo_set', t, jsonb_build_object('set', clean <> ''));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_invite(t uuid, invite_role member_role, invite_name text DEFAULT ''::text, invite_email text DEFAULT ''::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  raw text;
  inv uuid;
begin
  if not public.may(t, 'invite') then
    raise exception 'only the owner can invite';
  end if;
  if invite_role = 'owner' then
    raise exception 'invite them as a developer, then make them a co-owner';
  end if;
  if btrim(coalesce(invite_email, '')) <> '' and btrim(invite_email) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'that email does not look right';
  end if;
  raw := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.invites (table_id, role, token_hash, created_by, name, email)
    values (t, invite_role, encode(extensions.digest(raw, 'sha256'), 'hex'), auth.uid(),
            left(btrim(coalesce(invite_name, '')), 60), left(lower(btrim(coalesce(invite_email, ''))), 200))
    returning id into inv;
  perform public.log_activity(t, public.my_member_id(t), 'invite.created', inv,
    jsonb_build_object('role', invite_role, 'name', left(btrim(coalesce(invite_name, '')), 60)));
  return raw;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_client_answerer(m uuid, who text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.members;
begin
  select * into c from public.members where id = m and role = 'client' and removed_at is null;
  if not found or not public.may(c.table_id, 'clients') then
    raise exception 'only the owner sets who answers a client';
  end if;
  if who not in ('own', 'table') then
    raise exception 'a client is answered by their own assistant or by the table';
  end if;
  insert into public.client_settings (member_id, table_id, answered_by) values (c.id, c.table_id, who)
    on conflict (member_id) do update set answered_by = excluded.answered_by, updated_at = now();
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_client_sandbox(m uuid, enabled boolean, made_up_data boolean DEFAULT false, no_real_keys boolean DEFAULT false)
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
  if not found or not public.may(who.table_id, 'clients') then
    raise exception 'only the owner decides what a client can do';
  end if;
  if who.role <> 'client' then
    raise exception 'a sandbox is for a client';
  end if;
  if enabled and not exists (select 1 from public.sandboxes s where s.member_id = m and s.url is not null) then
    raise exception 'set the copy up first: it needs an address to open at';
  end if;
  -- Only the owner can answer these two, and a copy is not given until they have.
  if enabled and not (coalesce(made_up_data, false) and coalesce(no_real_keys, false)) then
    raise exception 'a copy is given only once you have said its previews run on made-up data and hold no real keys';
  end if;
  insert into public.sandboxes (member_id, table_id, mode, branch)
    values (m, who.table_id, case when enabled then 'sandbox' else 'chat' end, 'longtable/sandbox-'
      || coalesce(nullif(btrim(left(regexp_replace(lower(who.display_name), '[^a-z0-9]+', '-', 'g'), 30), '-'), ''), 'client')
      || '-' || left(m::text, 8))
    on conflict (member_id) do update set mode = excluded.mode;
  if enabled then
    update public.sandboxes set ticked_by = public.my_member_id(who.table_id), ticked_at = now() where member_id = m;
  end if;
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
$function$
;

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

CREATE OR REPLACE FUNCTION public.set_sandbox_links(t uuid, ours text, cap integer, m uuid DEFAULT NULL::uuid, theirs text DEFAULT NULL::text, folders text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ok constant text := '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$';
  clean text;
begin
  if not public.may(t, 'clients') then
    raise exception 'only the owner sets this';
  end if;
  if nullif(btrim(coalesce(ours, '')), '') is not null and btrim(ours) !~ ok then
    raise exception 'that is not an address that starts with https://';
  end if;
  if nullif(btrim(coalesce(theirs, '')), '') is not null and btrim(theirs) !~ ok then
    raise exception 'that is not an address that starts with https://';
  end if;
  if folders is not null then
    select coalesce(string_agg(f, ', '), '') into clean from (
      select btrim(btrim(x), '/') as f from regexp_split_to_table(folders, '[,\n]') x) y where f <> '';
    if clean ~ '[^A-Za-z0-9._/, -]' or clean ~ '(^|[/ ])\.\.([/, ]|$)' then
      raise exception 'folders are plain paths like apps/web/app, separated by commas';
    end if;
  end if;
  insert into public.table_sandbox (table_id, preview_url, cap, paths)
    values (t, nullif(left(btrim(coalesce(ours, '')), 300), ''), case when cap is null then 20 when cap <= 0 then null else least(1000, cap) end, left(coalesce(clean, ''), 600))
    on conflict (table_id) do update set preview_url = excluded.preview_url, cap = case when set_sandbox_links.cap is null then public.table_sandbox.cap when set_sandbox_links.cap <= 0 then null else least(1000, set_sandbox_links.cap) end,
      paths = case when folders is null then public.table_sandbox.paths else excluded.paths end;
  if m is not null then
    update public.sandboxes set url = nullif(left(btrim(coalesce(theirs, '')), 300), '') where member_id = m and table_id = t;
  end if;
end;
$function$
;

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
  if not found or not public.may(sb.table_id, 'clients') or not exists (select 1 from public.members x where x.id = m and x.removed_at is null) then
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
$function$
;

CREATE OR REPLACE FUNCTION public.delete_table(t uuid, confirm_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  n text;
begin
  if not public.is_main_owner(t) then
    raise exception 'only the main owner deletes the table';
  end if;
  select name into n from public.tables where id = t;
  if btrim(coalesce(confirm_name, '')) <> n then
    raise exception 'type the table''s name exactly to delete it';
  end if;
  perform set_config('longtable.deleting_table', 'on', true);
  delete from public.tables where id = t;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.transfer_ownership(m uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  who public.members;
  me uuid;
begin
  select * into who from public.members where id = m;
  if not found then
    raise exception 'only the owner can hand the table over';
  end if;
  -- One hand-over or removal at a table at a time, and the person read again once it is this one's turn.
  perform 1 from public.tables where id = who.table_id for update;
  select * into who from public.members where id = m for update;
  if not public.is_main_owner(who.table_id) then
    raise exception 'only the owner can hand the table over';
  end if;
  me := public.my_member_id(who.table_id);
  if who.id = me then
    raise exception 'you already own this table';
  end if;
  if who.removed_at is not null or who.role <> 'developer' then
    raise exception 'the table can only be handed to a developer who is at it';
  end if;
  update public.members set role = 'developer' where id = me;
  update public.members set role = 'owner' where id = who.id;
  update public.tables set main_owner = who.id where id = who.table_id;
  perform public.log_activity(who.table_id, me, 'table.handed_over', who.id, jsonb_build_object('name', who.display_name));
end;
$function$
;

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
  if not found then
    raise exception 'only the owner takes people off the table';
  end if;
  -- One hand-over or removal at a table at a time, and the person read again once it is this one's turn: a
  -- hand-over to them that went first has made them the owner, who cannot be taken off.
  perform 1 from public.tables where id = who.table_id for update;
  select * into who from public.members where id = m for update;
  if not (public.is_owner(who.table_id) or (who.role = 'client' and public.may(who.table_id, 'clients'))) then
    raise exception 'only an owner takes people off the table';
  end if;
  if who.role = 'owner' and (exists (select 1 from public.tables where id = who.table_id and main_owner = who.id) or not public.is_main_owner(who.table_id)) then
    raise exception 'the main owner cannot be taken off, and only the main owner takes a co-owner off';
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
$function$
;

-- With co-owners there can be more than one owner, so "the owner" these two fall back to is the main owner.
CREATE OR REPLACE FUNCTION public.final_seat_now(t uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select cn.member_id
    from public.connections cn
    join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
    join public.tables tb on tb.id = cn.table_id
   where cn.table_id = t and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds'
   order by (cn.member_id = coalesce(tb.final_seat, tb.main_owner)) desc, cn.created_at
   limit 1;
$function$
;
CREATE OR REPLACE FUNCTION public.start_round(t uuid, c uuid, q uuid, me uuid, task uuid DEFAULT NULL::uuid, title text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  seats uuid[];
  final uuid;
  offline text;
  online_seat uuid;
  r uuid := gen_random_uuid();
  s uuid;
  worker uuid;
  claudes integer;
  name text;
begin
  select array_agg(cn.member_id order by cn.created_at) into seats
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
   where cn.table_id = t and cn.revoked_at is null;
  if seats is null then
    return jsonb_build_object('message_id', q, 'answered_by', null);
  end if;

  if task is null then
    name := btrim(public.hide_secrets(coalesce(nullif(btrim(title), ''), (select left(split_part(m.body, E'\n', 1), 70) from public.messages m where m.id = q), 'Work')));
    task := gen_random_uuid();
    insert into public.tasks (id, table_id, chat_id, member_id, title, branch)
      values (task, t, c, me, left(coalesce(nullif(name, ''), 'Work'), 120),
              'longtable/' || coalesce(nullif(btrim(left(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), 40), '-'), ''), 'work') || '-' || left(task::text, 8));
  else
    update public.tasks set status = 'working', finished_at = null where id = task;
  end if;

  select cn.member_id into online_seat
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
   where cn.table_id = t and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds'
   order by cn.created_at limit 1;
  select coalesce(tb.final_seat, tb.main_owner), tb.when_final_offline
    into final, offline from public.tables tb where tb.id = t;
  if not (final = any (seats)) then
    final := coalesce(online_seat, seats[1]);
  elsif offline = 'next' and online_seat is not null and not exists (
      select 1 from public.connections cn where cn.member_id = final and cn.revoked_at is null
        and cn.last_seen > now() - interval '60 seconds') then
    final := online_seat;
  end if;

  if array_length(seats, 1) = 1 then
    insert into public.jobs (table_id, chat_id, member_id, question_id, kind, task_id) values (t, c, final, q, 'answer', task);
    perform public.log_activity(t, me, 'table.asked', q, jsonb_build_object('answered_by', final, 'task', task));
    return jsonb_build_object('message_id', q, 'answered_by', final, 'task', task);
  end if;

  select cn.member_id into worker
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
   where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
   order by (cn.member_id = me) desc, cn.created_at limit 1;
  select count(distinct cn.member_id) into claudes
    from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
   where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds';
  if worker is not null then
    foreach s in array seats loop
      -- Only an AI that is on right now is asked for its view: one whose computer is closed would hold everyone up.
      if s <> worker and exists (select 1 from public.connections cn where cn.member_id = s and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds') then
        insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, task_id) values (t, c, s, q, 'view', r, task);
      end if;
    end loop;
    -- With another Claude there to hand parts to, the work starts with a plan.
    insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, status, task_id)
      values (t, c, worker, q, case when claudes >= 2 then 'plan' else 'work' end, r, 'waiting', task);
    perform public.log_activity(t, me, 'table.asked', q, jsonb_build_object('answered_by', final, 'worker', worker, 'round', r, 'task', task));
    return jsonb_build_object('message_id', q, 'answered_by', final, 'worker', worker, 'round', r, 'task', task);
  end if;

  foreach s in array seats loop
    if s <> final and exists (select 1 from public.connections cn where cn.member_id = s and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds') then
      insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, task_id) values (t, c, s, q, 'view', r, task);
    end if;
  end loop;
  insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, status, task_id)
    values (t, c, final, q, 'combine', r, 'waiting', task);
  perform public.log_activity(t, me, 'table.asked', q, jsonb_build_object('answered_by', final, 'round', r, 'task', task));
  return jsonb_build_object('message_id', q, 'answered_by', final, 'round', r, 'task', task);
end;
$function$
;
