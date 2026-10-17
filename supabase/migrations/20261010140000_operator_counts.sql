-- Step 6: the operator's page. Whoever runs a Longtable sees how it is doing in counts
-- only: no names, no messages, no table titles. Operators are listed by email in a table nobody can read or write
-- through the API; the deployer adds them with SQL, so no address is ever in this repo:
--   insert into public.operators (email) values ('them@example.com');

create table public.operators (email text primary key check (email = lower(btrim(email))));
alter table public.operators enable row level security;
revoke all on public.operators from public, anon, authenticated;

create function public.is_operator()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.operators o where o.email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
revoke all on function public.is_operator() from public, anon;
grant execute on function public.is_operator() to authenticated;

create function public.operator_counts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  week timestamptz := now() - interval '7 days';
  day timestamptz := now() - interval '1 day';
begin
  if not public.is_operator() then
    raise exception 'only the people running this Longtable see these counts';
  end if;
  return jsonb_build_object(
    'tables', (select count(*) from public.tables),
    'tables_active_7d', (select count(distinct table_id) from public.messages where created_at > week),
    'people', (select count(*) from public.members where removed_at is null),
    'clients', (select count(*) from public.members where removed_at is null and role = 'client'),
    'messages_24h', (select count(*) from public.messages where created_at > day),
    'messages_7d', (select count(*) from public.messages where created_at > week),
    'decisions_7d', (select count(*) from public.decisions where created_at > week),
    'client_requests_7d', (select count(*) from public.requests where created_at > week),
    'ai_on_now', (select count(*) from public.connections where revoked_at is null and last_seen > now() - interval '60 seconds'),
    'ai_connected', (select count(*) from public.connections where revoked_at is null),
    'ai_codex', (select count(*) from public.connections where revoked_at is null and kind = 'codex'),
    'jobs_done_7d', (select count(*) from public.jobs where status = 'done' and created_at > week),
    'jobs_failed_7d', (select count(*) from public.jobs where status = 'failed' and created_at > week),
    'answer_seconds_median_7d', (
      select round(percentile_cont(0.5) within group (order by extract(epoch from finished_at - created_at))::numeric, 1)
        from public.jobs where status = 'done' and kind in ('answer', 'combine', 'client') and created_at > week and finished_at is not null));
end;
$$;
revoke all on function public.operator_counts() from public, anon;
grant execute on function public.operator_counts() to authenticated;
