-- A person's own look at a table: a picture, the colour behind their letter, the colour of their name, and a short
-- line about what they are on. Each person changes only their own.

alter table public.members
  add column avatar text check (avatar is null or (char_length(avatar) <= 60000 and avatar ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$')),
  add column name_color text check (name_color is null or name_color ~ '^(#[0-9a-fA-F]{6}|oklch\([0-9. ]{5,30}\))$'),
  add column status text not null default '' check (char_length(status) <= 80);

create function public.update_profile(t uuid, new_name text, new_color text, new_name_color text, new_avatar text, new_status text)
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
  update public.members
     set display_name = clean,
         color = new_color,
         name_color = nullif(btrim(coalesce(new_name_color, '')), ''),
         avatar = nullif(coalesce(new_avatar, ''), ''),
         status = left(btrim(coalesce(new_status, '')), 80)
   where id = me and removed_at is null;
end;
$$;
revoke all on function public.update_profile(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.update_profile(uuid, text, text, text, text, text) to authenticated;
