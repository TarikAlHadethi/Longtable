-- Taking the test client off marked every decision about what it had asked as not for a client to hear, the ones
-- already told included, so the team's card for a decision the test client did hear then read as if nobody had been
-- told. Only a decision that has not been told yet can still reach every client, so only those are changed now.

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
   where d.request_id = r.id and r.member_id = m.id and m.table_id = t and m.test and d.delivered_at is null;
  delete from public.members where table_id = t and test;
end;
$$;
