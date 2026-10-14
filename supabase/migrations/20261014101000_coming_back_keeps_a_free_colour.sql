-- Someone taken off the table could not come back. Their bubble colour stays on their row while they are away, and
-- the colour is given to anyone who joins meanwhile; bringing them back then broke the rule that two people at the
-- table never share one (members_one_bubble_each), and the invite failed with a raw duplicate-key error. Now they
-- come back with a free colour when theirs was taken. The same for a test client taken off and added again. Found by
-- the chaos run (rule Q4, a removed person can always come back).

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
    update public.members set removed_at = null, role = inv.role, display_name = left(words, 60),
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
$function$;

CREATE OR REPLACE FUNCTION public.add_test_client(t uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  seat uuid;
begin
  if not exists (select 1 from public.members o where o.table_id = t and o.user_id = auth.uid() and o.removed_at is null and o.role = 'owner') then
    raise exception 'only the owner adds a test client';
  end if;
  select id into seat from public.members where table_id = t and test;
  if found then
    update public.members x set removed_at = null,
           bubble = case when exists (select 1 from public.members o where o.table_id = x.table_id and o.bubble = x.bubble
           and o.id <> x.id and o.removed_at is null) then public.free_bubble(x.table_id) else bubble end
     where id = seat;
    return seat;
  end if;
  insert into public.members (table_id, user_id, role, display_name, color, test)
    values (t, null, 'client', 'Test client', 'oklch(0.62 0.03 260)', true) returning id into seat;
  return seat;
end;
$function$;
