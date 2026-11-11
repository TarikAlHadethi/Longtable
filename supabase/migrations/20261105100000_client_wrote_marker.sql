-- "Elena wrote" under People, for whoever may write in a client's chat, until they have opened it. Where each person
-- has read to is kept here, so opening the chat on a phone clears it on the computer too. Lines a client wrote to an
-- assistant of their own stay private: they never count, and the team's channel never hears of them.
create table public.client_chat_reads (
  member_id uuid not null references public.members(id) on delete cascade,
  client_id uuid not null references public.members(id) on delete cascade,
  read_at timestamptz not null,
  primary key (member_id, client_id)
);
alter table public.client_chat_reads enable row level security;
revoke all on public.client_chat_reads from public, anon, authenticated;

-- What was said before this existed is not news.
insert into public.client_chat_reads (member_id, client_id, read_at)
select m.id, c.id, now() from public.members m
  join public.members c on c.table_id = m.table_id and c.role = 'client'
 where m.role <> 'client';

create function public.clients_wrote(t uuid) returns table (client uuid, at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.id, x.at
    from public.members me
    join public.members c on c.table_id = me.table_id and c.role = 'client' and c.removed_at is null
    cross join lateral (select greatest(
      (select max(l.created_at) from public.client_lines l where l.member_id = c.id and l.who = 'client' and l.by_table),
      (select max(r.created_at) from public.requests r where r.member_id = c.id)) as at) x
    left join public.client_chat_reads seen on seen.member_id = me.id and seen.client_id = c.id
   where me.table_id = t and me.user_id = auth.uid() and me.removed_at is null and public.may(t, 'clients')
     and x.at > coalesce(seen.read_at, me.created_at)
   order by x.at;
$$;

create function public.client_chat_read(m uuid, upto timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare
  who public.members;
begin
  select * into who from public.members where id = m and role = 'client';
  if not found or not public.may(who.table_id, 'clients') then raise exception 'only someone who may write in this chat keeps a place in it'; end if;
  insert into public.client_chat_reads (member_id, client_id, read_at)
  values (public.my_member_id(who.table_id), m, least(upto, now()))
  on conflict (member_id, client_id) do update set read_at = greatest(public.client_chat_reads.read_at, excluded.read_at);
end;
$$;

-- Only which client, never their words.
create function public.broadcast_client_wrote() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'client_lines' then
    if not (new.who = 'client' and new.by_table) then return null; end if;
  end if;
  perform realtime.send(jsonb_build_object('table', 'client_wrote', 'record', jsonb_build_object('id', new.member_id)),
    'INSERT', 'team:' || new.table_id::text, true);
  return null;
end;
$$;
create trigger client_lines_wrote after insert on public.client_lines
  for each row execute function public.broadcast_client_wrote();
create trigger requests_wrote after insert on public.requests
  for each row execute function public.broadcast_client_wrote();

revoke all on function public.clients_wrote(uuid) from public, anon;
revoke all on function public.client_chat_read(uuid, timestamptz) from public, anon;
revoke all on function public.broadcast_client_wrote() from public, anon, authenticated;
grant execute on function public.clients_wrote(uuid) to authenticated;
grant execute on function public.client_chat_read(uuid, timestamptz) to authenticated;
