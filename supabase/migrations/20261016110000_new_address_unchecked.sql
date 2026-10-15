-- A client's copy that gets a new address has not been looked at yet. The check "it opens without signing in" was
-- kept from the old address, so after the owner corrected a mistyped address, or the hosting reported a new one, the
-- set-up showed the step as passed for an address nobody had opened. Whenever the address changes, by any path (the
-- owner typing it, or GitHub's deployment status), what was found at the old one is cleared.

create or replace function public.sandbox_address_changed()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.url is distinct from old.url then
    new.open_ok := null;
    new.checked_at := null;
  end if;
  return new;
end;
$$;
revoke all on function public.sandbox_address_changed() from public, anon, authenticated;

drop trigger if exists sandbox_address_changed on public.sandboxes;
create trigger sandbox_address_changed before update of url on public.sandboxes
  for each row execute function public.sandbox_address_changed();
