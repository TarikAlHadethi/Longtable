-- Each person's messages sit in a bubble of their own colour. A colour belongs to one person at a table at a time:
-- everyone gets a free one, at random, when they join, and may swap it for any colour nobody else holds.

alter table public.members
  add column bubble text check (bubble is null or bubble in ('rose', 'peach', 'sand', 'lime', 'mint', 'teal', 'sky', 'blue', 'iris', 'lilac', 'pink', 'stone'));
create unique index members_one_bubble_each on public.members (table_id, bubble) where removed_at is null and bubble is not null;

-- A colour nobody at the table holds, at random; null when all twelve are taken.
create function public.free_bubble(t uuid)
returns text language sql volatile security definer set search_path = '' as $$
  select c from unnest(array['rose', 'peach', 'sand', 'lime', 'mint', 'teal', 'sky', 'blue', 'iris', 'lilac', 'pink', 'stone']) c
   where not exists (select 1 from public.members m where m.table_id = t and m.bubble = c and m.removed_at is null)
   order by random() limit 1;
$$;
revoke all on function public.free_bubble(uuid) from public, anon, authenticated;

create function public.give_bubble()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.bubble is null then
    new.bubble := public.free_bubble(new.table_id);
  end if;
  return new;
end;
$$;
create trigger members_bubble before insert on public.members
  for each row execute function public.give_bubble();

-- Everyone already at a table gets one now.
do $$
declare m record;
begin
  for m in select id, table_id from public.members where bubble is null and removed_at is null order by created_at loop
    update public.members set bubble = public.free_bubble(m.table_id) where id = m.id;
  end loop;
end $$;

drop function public.update_profile(uuid, text, text, text, text, text);
create function public.update_profile(t uuid, new_name text, new_color text, new_name_color text, new_avatar text, new_status text, new_bubble text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := public.my_member_id(t);
  clean text := left(btrim(coalesce(new_name, '')), 60);
begin
  if me is null then
    raise exception 'you are not at this table';
  end if;
  if clean = '' then
    raise exception 'you need a name';
  end if;
  if new_color is null or new_color !~ '^(#[0-9a-fA-F]{6}|oklch\([0-9. ]{5,30}\))$' then
    raise exception 'that is not a colour';
  end if;
  if new_bubble is not null and exists (select 1 from public.members m where m.table_id = t and m.bubble = new_bubble and m.id <> me and m.removed_at is null) then
    raise exception 'someone else at the table has that bubble colour';
  end if;
  update public.members
     set display_name = clean,
         color = new_color,
         name_color = nullif(btrim(coalesce(new_name_color, '')), ''),
         avatar = nullif(coalesce(new_avatar, ''), ''),
         status = left(btrim(coalesce(new_status, '')), 80),
         bubble = coalesce(new_bubble, bubble)
   where id = me and removed_at is null;
end;
$$;
revoke all on function public.update_profile(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.update_profile(uuid, text, text, text, text, text, text) to authenticated;
