-- The list behind "/" now also carries the commands every Claude has built in, which the connection marks as
-- 'builtin' so the screen can set them under the person's own. This function kept only three kinds and turned any
-- other into 'command', which would have mixed the two together. Nothing else about it changes: names and one line
-- each, cleaned and cut, at most 150.

create or replace function public.runner_commands(token text, list jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
  clean jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', left(x ->> 'name', 60),
           'about', left(public.hide_secrets(coalesce(x ->> 'about', '')), 200),
           'kind', case when x ->> 'kind' in ('command', 'skill', 'prompt', 'builtin') then x ->> 'kind' else 'command' end)), '[]'::jsonb)
    into clean
    from (select x from jsonb_array_elements(coalesce(list, '[]'::jsonb)) x
           where x ->> 'name' ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,59}$' limit 150) s;
  update public.connections set commands = clean where id = c.id;
  return jsonb_array_length(clean);
end;
$$;
