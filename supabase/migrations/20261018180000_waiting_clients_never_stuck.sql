-- Waiting words were never answered once 20 others waited elsewhere (17 Oct 2026, found by step21): the loop took the
-- 20 oldest waiting lines across every table and only then skipped the ones with no team AI on, so a pile of lines at
-- tables whose AIs are off kept everyone else's from ever being looked at. Only lines a team AI can answer now are
-- taken.
--
-- And the connection 0.1.23: the client's assistant looks into the project when asked where it stands, instead of
-- saying it does not know (his words: "when i ask it where sams is, it doesnt know").

create or replace function public.answer_waiting_clients()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  w record;
  seat uuid;
  n integer := 0;
begin
  for w in
    select l.* from public.client_lines l join public.members m on m.id = l.member_id and m.removed_at is null
     where l.waiting and l.who = 'client'
       and public.client_desk_seat(l.table_id) is not null
       and not exists (select 1 from public.jobs j where j.line_id = l.id and j.status in ('queued', 'running'))
     order by l.created_at limit 20
     for update of l skip locked
  loop
    seat := public.client_desk_seat(w.table_id);
    continue when seat is null;
    insert into public.jobs (table_id, member_id, kind, line_id, subject) values (w.table_id, seat, 'client', w.id, w.member_id);
    update public.client_lines set waiting = false where id = w.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.answer_waiting_clients() from public, anon, authenticated;

update public.connect_release set version = '0.1.23', set_at = now();
