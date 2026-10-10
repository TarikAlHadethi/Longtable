-- Step 6: usage. After each job a connection reports its person's plan limits, as Claude Code and Codex report
-- them (each window's use in percent and when it resets). The team's Usage page shows them beside each person's
-- work at this table. Only the numbers are kept: no account email, no plan credentials.

alter table public.connections add column limits jsonb not null default '{}'::jsonb;
alter table public.connections add column limits_at timestamptz;
-- connections uses column grants (the token hash stays unreadable), so new columns must be granted by name.
grant select (limits, limits_at) on public.connections to authenticated;

create function public.runner_report(token text, limits jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
begin
  if runner_report.limits is null or jsonb_typeof(runner_report.limits) <> 'object' or octet_length(runner_report.limits::text) > 4000 then
    raise exception 'limits must be a small object';
  end if;
  update public.connections
     set limits = jsonb_build_object(
           'ai', runner_report.limits ->> 'ai',
           'plan', runner_report.limits ->> 'plan',
           'status', runner_report.limits ->> 'status',
           'windows', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'name', left(w ->> 'name', 20),
                      'used', least(greatest(coalesce((w ->> 'used')::numeric, 0), 0), 100),
                      'resets', w ->> 'resets'))
               from jsonb_array_elements(coalesce(runner_report.limits -> 'windows', '[]'::jsonb)) w
              where jsonb_typeof(w) = 'object'), '[]'::jsonb)),
         limits_at = now()
   where id = c.id;
end;
$$;
revoke all on function public.runner_report(text, jsonb) from public;
grant execute on function public.runner_report(text, jsonb) to anon, authenticated;
