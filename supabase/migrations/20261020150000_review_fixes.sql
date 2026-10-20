-- Review fixes.
-- A person's own full Claude Code starts in "Accept edits", which is what it did before the mode picker existed, and
-- what the picker now shows: a mode nobody picked is never shown as one it is not.
alter table public.connections alter column mode set default 'acceptEdits';
update public.connections set mode = 'acceptEdits' where mode is null;

-- Someone taken off and invited back starts with none of what an owner had turned on for them before.
CREATE OR REPLACE FUNCTION public.accept_invite(token text, my_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  inv public.invites;
  me uuid;
  was public.members;
  words text;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  select * into inv from public.invites
    where token_hash = encode(extensions.digest(token, 'sha256'), 'hex')
    for update;
  if not found then
    raise exception 'this invite link is not valid';
  end if;
  select * into was from public.members m where m.table_id = inv.table_id and m.user_id = auth.uid();
  if found and was.removed_at is null then
    return inv.table_id;
  end if;
  if inv.used_at is not null then
    raise exception 'this invite link was already used';
  end if;
  if inv.expires_at < now() then
    raise exception 'this invite link has expired';
  end if;
  words := coalesce(nullif(btrim(coalesce(my_name, '')), ''), nullif(inv.name, ''));
  if words is null then
    raise exception 'add your name';
  end if;
  if was.id is not null then
    -- Their bubble colour may have gone to someone else while they were away: then they get a free one.
    update public.members set removed_at = null, role = inv.role, can_settings = false, can_invite = false, can_clients = false, display_name = left(words, 60),
           bubble = case when exists (select 1 from public.members o where o.table_id = was.table_id and o.bubble = was.bubble
           and o.id <> was.id and o.removed_at is null) then public.free_bubble(was.table_id) else bubble end
     where id = was.id
      returning id into me;
  else
    insert into public.members (table_id, user_id, role, display_name, color)
      values (inv.table_id, auth.uid(), inv.role, left(words, 60), public.next_color(inv.table_id)) returning id into me;
  end if;
  update public.invites set used_by = auth.uid(), used_at = now() where id = inv.id;
  perform public.log_activity(inv.table_id, me, 'member.joined', me, jsonb_build_object('role', inv.role, 'name', left(words, 60)));
  return inv.table_id;
end;
$function$
;

-- A teammate given the clients can set up a client's copy, so they can check that it opens too.
CREATE OR REPLACE FUNCTION public.note_sandbox_open(m uuid, ok boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  t uuid;
begin
  select s.table_id into t from public.sandboxes s where s.member_id = m;
  if t is null or not public.may(t, 'clients') then
    raise exception 'only an owner, or a teammate given the clients, checks a copy';
  end if;
  update public.sandboxes set checked_at = now(), open_ok = ok where member_id = m;
end;
$function$
;

-- The connection that refuses pushes from its person's Claude however written, merges two parts in full mode, keeps
-- a full-mode question waiting on its person from blocking the table, and shows everything a command asks for.
update public.connect_release set version = '0.1.30', set_at = now();
