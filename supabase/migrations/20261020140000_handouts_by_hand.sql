-- A person changes a handout's words themselves, the way Claude Design lets you edit text in place: what they
-- changed becomes a new version, made by them, with secrets hidden like any other version. The team of the table
-- only, at most sixty an hour from one person.
create function public.edit_page(p uuid, html text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  pg public.pages := public.team_page(p);
  me uuid := public.my_member_id(pg.table_id);
begin
  if char_length(coalesce(html, '')) = 0 or char_length(html) > 2000000 then
    raise exception 'a page is between 1 character and 2,000,000';
  end if;
  if (select count(*) from public.page_versions v where v.made_by = me and not v.by_ai and v.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'that is a lot of changes in an hour: try again in a little while';
  end if;
  update public.pages set version = version + 1, touched_at = now() where id = pg.id returning * into pg;
  insert into public.page_versions (page_id, table_id, n, html, made_by, by_ai, note)
    values (pg.id, pg.table_id, pg.version, public.hide_secrets(html), me, false, 'Edited by hand');
  return pg.version;
end;
$$;
revoke all on function public.edit_page(uuid, text) from public, anon;
grant execute on function public.edit_page(uuid, text) to authenticated;
