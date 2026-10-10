-- The table has a model of its own: the one its single answer is written on. It is separate from the model each
-- person picked for their own AI, which gives its view. The team reads and sets it; the client never sees it.

create table public.table_ai (
  table_id uuid primary key references public.tables(id) on delete cascade,
  model text,
  updated_at timestamptz not null default now()
);
alter table public.table_ai enable row level security;
revoke all on public.table_ai from public, anon, authenticated;
grant select on public.table_ai to authenticated;
create policy "the team reads the table's model" on public.table_ai
  for select to authenticated using (public.is_team(table_id));
create trigger table_ai_broadcast after insert or update on public.table_ai
  for each row execute function public.broadcast_team_change();

create function public.set_table_model(t uuid, model text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  clean text := btrim(coalesce(model, ''));
begin
  if not public.is_team(t) then
    raise exception 'only the team can choose the table''s model';
  end if;
  if clean !~ '^[A-Za-z0-9._ -]{0,60}$' then
    raise exception 'that is not a model name';
  end if;
  insert into public.table_ai (table_id, model) values (t, nullif(clean, ''))
    on conflict (table_id) do update set model = excluded.model, updated_at = now();
end;
$$;
revoke all on function public.set_table_model(uuid, text) from public, anon;
grant execute on function public.set_table_model(uuid, text) to authenticated;

-- What a connection should run: its person's pick for their own AI, and the table's pick for the table's answer.
create function public.runner_models(token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
begin
  return jsonb_build_object('mine', c.model_choice,
    'table', (select a.model from public.table_ai a where a.table_id = c.table_id));
end;
$$;
revoke all on function public.runner_models(text) from public;
grant execute on function public.runner_models(text) to anon, authenticated;
