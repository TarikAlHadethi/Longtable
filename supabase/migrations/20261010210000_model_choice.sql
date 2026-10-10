-- A person picks the model their own AI runs, from the table. The choice is kept on their connection; the
-- connection asks for it before each job. A connection also reports which models it can run.
-- Disconnecting also clears that person's unfinished jobs, so the table stops saying it is working.

alter table public.connections add column model_choice text;
grant select (model_choice) on public.connections to authenticated;

create function public.set_model(conn uuid, model text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  cn public.connections;
  clean text := btrim(coalesce(model, ''));
begin
  select * into cn from public.connections where id = conn and revoked_at is null for update;
  if not found or cn.member_id <> public.my_member_id(cn.table_id) then
    raise exception 'you can only choose the model for your own AI';
  end if;
  if clean !~ '^[A-Za-z0-9._ -]{0,60}$' then
    raise exception 'that is not a model name';
  end if;
  update public.connections set model_choice = nullif(clean, '') where id = conn;
end;
$$;
revoke all on function public.set_model(uuid, text) from public, anon;
grant execute on function public.set_model(uuid, text) to authenticated;

create function public.runner_model(token text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
begin
  return c.model_choice;
end;
$$;
revoke all on function public.runner_model(text) from public;
grant execute on function public.runner_model(text) to anon, authenticated;

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
$$;

create or replace function public.disconnect(conn uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  cn public.connections;
begin
  select * into cn from public.connections where id = conn for update;
  if not found or not (cn.member_id = public.my_member_id(cn.table_id) or public.is_owner(cn.table_id)) then
    raise exception 'not yours to disconnect';
  end if;
  update public.connections set revoked_at = now() where id = conn and revoked_at is null;
  -- Nothing of theirs is left looking busy, unless another connection of theirs is still on.
  if not exists (select 1 from public.connections x where x.member_id = cn.member_id and x.revoked_at is null) then
    update public.jobs set status = 'failed', error = 'its AI was disconnected'
     where member_id = cn.member_id and status in ('queued', 'running', 'waiting');
  end if;
  perform public.log_activity(cn.table_id, public.my_member_id(cn.table_id), 'connection.removed', conn, jsonb_build_object('kind', cn.kind));
end;
$$;
