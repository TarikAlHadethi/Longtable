-- Handing the table to someone else, and reporting a bug.

-- The owner makes a developer the owner and becomes a developer. One owner at a time, always.
create function public.transfer_ownership(m uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  who public.members;
  me uuid;
begin
  select * into who from public.members where id = m for update;
  if not found or not public.is_owner(who.table_id) then
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
  perform public.log_activity(who.table_id, me, 'table.handed_over', who.id, jsonb_build_object('name', who.display_name));
end;
$$;
revoke all on function public.transfer_ownership(uuid) from public, anon;
grant execute on function public.transfer_ownership(uuid) to authenticated;

-- Bug reports go to whoever runs this Longtable. People write them; only an operator reads them.
create table public.bug_reports (
  id uuid primary key default gen_random_uuid(),
  table_id uuid references public.tables (id) on delete set null,
  member_id uuid references public.members (id) on delete set null,
  body text not null check (char_length(body) between 1 and 4000),
  place text not null default '' check (char_length(place) <= 300),
  browser text not null default '' check (char_length(browser) <= 300),
  created_at timestamptz not null default now()
);
alter table public.bug_reports enable row level security;
revoke all on public.bug_reports from public, anon, authenticated;

create function public.report_bug(t uuid, body text, place text default '', browser text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := public.my_member_id(t);
begin
  if me is null then
    raise exception 'only someone at the table can report a bug from it';
  end if;
  if char_length(btrim(coalesce(body, ''))) = 0 then
    raise exception 'say what went wrong';
  end if;
  -- A handful an hour from one person is plenty.
  if (select count(*) from public.bug_reports b where b.member_id = me and b.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'that is a lot of reports in an hour; try again later';
  end if;
  insert into public.bug_reports (table_id, member_id, body, place, browser)
    values (t, me, left(btrim(body), 4000), left(coalesce(place, ''), 300), left(coalesce(browser, ''), 300));
end;
$$;
revoke all on function public.report_bug(uuid, text, text, text) from public, anon;
grant execute on function public.report_bug(uuid, text, text, text) to authenticated;

create function public.operator_bugs()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_operator() then
    raise exception 'not found';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'body', b.body, 'place', b.place, 'browser', b.browser, 'at', b.created_at) order by b.created_at desc)
    from (select * from public.bug_reports order by created_at desc limit 100) b), '[]'::jsonb);
end;
$$;
revoke all on function public.operator_bugs() from public, anon;
grant execute on function public.operator_bugs() to authenticated;
