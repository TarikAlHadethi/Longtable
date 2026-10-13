-- Taking the test client off left what it had been told readable by every real client. Its requests went with the
-- seat, and that emptied the request on each thing it was told (the key is "set null"), and a thing said about no
-- request is a thing said to every client. The same happened to a decision still open about one of its requests:
-- it would later have been told to everyone. Now what it was told goes first, and decisions about what it asked are
-- no longer for any client to hear; the team keeps their cards.

create or replace function public.remove_test_client(t uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.members o where o.table_id = t and o.user_id = auth.uid() and o.removed_at is null and o.role = 'owner') then
    raise exception 'only the owner removes the test client';
  end if;
  delete from public.client_updates u
   using public.requests r, public.members m
   where u.request_id = r.id and r.member_id = m.id and m.table_id = t and m.test;
  update public.decisions d set affects_client = false
    from public.requests r, public.members m
   where d.request_id = r.id and r.member_id = m.id and m.table_id = t and m.test;
  delete from public.members where table_id = t and test;
end;
$$;
