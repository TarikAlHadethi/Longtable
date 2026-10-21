-- Each connection says which common tools its Claude finds on that computer (git, node, npm, docker, python), so its
-- AI window shows them and a missing one is seen before a request fails on it.
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
           -- Which common tools its Claude finds on that computer: known names only.
           'tools', case when jsonb_typeof(runner_report.limits -> 'tools') = 'array' then coalesce((
               select jsonb_agg(distinct t) from jsonb_array_elements_text(runner_report.limits -> 'tools') t
                where t in ('git', 'node', 'npm', 'docker', 'python')), '[]'::jsonb)
             else c.limits -> 'tools' end,
           -- What it reads: the repository's address (only a plain one, never with a sign-in in it), the last part of
           -- its person's own folder, and whether the table's repository is one that computer knows.
           'reads', case when jsonb_typeof(runner_report.limits -> 'reads') = 'object' then jsonb_build_object(
               'repo', case when runner_report.limits -> 'reads' ->> 'repo' ~ '^(https://[A-Za-z0-9.-]+/[A-Za-z0-9/._~+-]{1,200}|git@[A-Za-z0-9.-]+:[A-Za-z0-9/._~+-]{1,200}|ssh://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9/._~+-]{1,200})$'
                 then runner_report.limits -> 'reads' ->> 'repo' end,
               'folder', case when runner_report.limits -> 'reads' ->> 'folder' ~ '^[^/\\]{1,80}$'
                 then public.hide_secrets(runner_report.limits -> 'reads' ->> 'folder') end,
               'known', coalesce(runner_report.limits -> 'reads' ->> 'known', 'true') <> 'false')
             else c.limits -> 'reads' end,
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
