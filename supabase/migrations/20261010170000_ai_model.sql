-- The table's home shows each person's AI and the model it last used. A connection now reports that model along
-- with its plan limits. A report that carries no limits (no windows) keeps the last ones.

create or replace function public.runner_report(token text, limits jsonb)
returns void language plpgsql security definer set search_path = '' as $$
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
$$;
