-- The connection keeps itself up to date (17 Oct 2026): nobody should have to disconnect and connect again
-- after an update.
--
-- Longtable says which version of the connection every computer should run; each connection asks now and then
-- (`runner_release`, with its own device token) and, when it is newer than itself, fetches exactly that version from
-- npm, checks it against the registry's fingerprint, and starts again on it between jobs. Only this row decides: a
-- version somebody else published to npm is never installed. Raising it is part of shipping a new connection, done
-- by a migration like this one (the operator could also set it by hand with SQL). Each connection reports its version.

create table public.connect_release (
  one boolean primary key default true check (one),
  version text not null check (version ~ '^\d+\.\d+\.\d+$'),
  set_at timestamptz not null default now()
);
alter table public.connect_release enable row level security;
revoke all on public.connect_release from anon, authenticated;
insert into public.connect_release (version) values ('0.1.20');

create function public.runner_release(token text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
begin
  return (select version from public.connect_release where one);
end;
$$;
revoke all on function public.runner_release(text) from public;
grant execute on function public.runner_release(text) to anon, authenticated;

CREATE OR REPLACE FUNCTION public.runner_report(token text, limits jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.connections := public.connection_for(token);
begin
  if runner_report.limits is null or jsonb_typeof(runner_report.limits) <> 'object' or octet_length(runner_report.limits::text) > 4000 then
    raise exception 'limits must be a small object';
  end if;
  update public.connections
     set limits = jsonb_build_object(
           'ai', coalesce(runner_report.limits ->> 'ai', c.limits ->> 'ai'),
           'plan', coalesce(left(runner_report.limits ->> 'plan', 40), c.limits ->> 'plan'),
           'model', coalesce(left(runner_report.limits ->> 'model', 60), c.limits ->> 'model'),
           'status', coalesce(runner_report.limits ->> 'status', c.limits ->> 'status'),
           -- The version of the connection itself, so its window shows it and an update can be seen to have taken.
           'version', case when runner_report.limits ->> 'version' ~ '^\d+\.\d+\.\d+$' then runner_report.limits ->> 'version' else c.limits ->> 'version' end,
           -- Whether fast mode can serve this AI, as its Claude Code said, and why not.
           'fast', case when runner_report.limits ->> 'fast' in ('off', 'on', 'cooldown') then runner_report.limits ->> 'fast' else c.limits ->> 'fast' end,
           'fast_why', case when runner_report.limits ? 'fast' then left(nullif(regexp_replace(coalesce(runner_report.limits ->> 'fast_why', ''), '[^a-z_]', '', 'g'), ''), 40) else c.limits ->> 'fast_why' end,
           'models', case when jsonb_typeof(runner_report.limits -> 'models') = 'array' then coalesce((
             select jsonb_agg(left(v, 40)) from (
               select v from jsonb_array_elements_text(runner_report.limits -> 'models') v limit 12) picked), '[]'::jsonb)
             else coalesce(c.limits -> 'models', '[]'::jsonb) end,
           'windows', case when jsonb_typeof(runner_report.limits -> 'windows') = 'array' then coalesce((
             select jsonb_agg(jsonb_build_object(
                      'name', left(w ->> 'name', 20),
                      'used', least(greatest(coalesce((w ->> 'used')::numeric, 0), 0), 100),
                      'resets', w ->> 'resets'))
               from jsonb_array_elements(runner_report.limits -> 'windows') w
              where jsonb_typeof(w) = 'object'), '[]'::jsonb)
             else coalesce(c.limits -> 'windows', '[]'::jsonb) end),
         limits_at = now()
   where id = c.id;
end;
$function$
;
