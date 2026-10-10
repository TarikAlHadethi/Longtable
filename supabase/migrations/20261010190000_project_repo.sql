-- Where the project's code lives: its repository's address, kept per table and read by the team only (never the
-- client). The Connect window puts it in the setup message, so a person's AI can be opened in any folder: the
-- connection fetches its own copy from this address with that person's own git sign-in.

create table public.table_code (
  table_id uuid primary key references public.tables(id) on delete cascade,
  repo_url text not null,
  updated_at timestamptz not null default now()
);
alter table public.table_code enable row level security;
revoke all on public.table_code from public, anon, authenticated;
grant select on public.table_code to authenticated;
create policy "the team reads where the code is" on public.table_code
  for select to authenticated using (public.is_team(table_id));

create function public.set_table_repo(t uuid, url text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  clean text := btrim(coalesce(url, ''));
begin
  if not public.is_team(t) then
    raise exception 'only the team can say where the code is';
  end if;
  if clean = '' then
    delete from public.table_code where table_id = t;
  else
    if clean !~ '^(https://|ssh://|git@)[A-Za-z0-9@:/._~+-]{4,250}$' then
      raise exception 'that does not look like a repository address; it starts with https:// or git@';
    end if;
    insert into public.table_code (table_id, repo_url) values (t, clean)
      on conflict (table_id) do update set repo_url = excluded.repo_url, updated_at = now();
  end if;
  perform public.log_activity(t, public.my_member_id(t), 'table.repo_set', t, jsonb_build_object('set', clean <> ''));
end;
$$;
revoke all on function public.set_table_repo(uuid, text) from public, anon;
grant execute on function public.set_table_repo(uuid, text) to authenticated;
