-- Last seen: when each person last had a Longtable tab open at this table. Kept apart from members, so that writing it
-- (every few minutes from every open tab) is never broadcast as a change to the person. Only the team reads it; a
-- client never learns when the team was last around.

create table public.member_seen (
  member_id uuid primary key references public.members (id) on delete cascade,
  table_id uuid not null references public.tables (id) on delete cascade,
  at timestamptz not null default now()
);
alter table public.member_seen enable row level security;
revoke all on public.member_seen from public, anon, authenticated;

-- Said by the page when it opens, when the tab comes back, and every few minutes while it is in view.
create function public.i_am_here(t uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  m uuid := public.my_member_id(t);
begin
  if m is null then return; end if;
  insert into public.member_seen (member_id, table_id, at) values (m, t, now())
    on conflict (member_id) do update set at = now() where public.member_seen.at < now() - interval '30 seconds';
end;
$$;
revoke all on function public.i_am_here(uuid) from public, anon;
grant execute on function public.i_am_here(uuid) to authenticated;

create function public.last_seen(t uuid)
returns table (member_id uuid, at timestamptz) language sql stable security definer set search_path = '' as $$
  select s.member_id, s.at from public.member_seen s join public.members m on m.id = s.member_id
   where s.table_id = t and m.table_id = t and m.removed_at is null and public.is_team(t);
$$;
revoke all on function public.last_seen(uuid) from public, anon;
grant execute on function public.last_seen(uuid) to authenticated;
