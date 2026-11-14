-- Connect 0.1.50: a person's own computer, from their own page. The connection opens a small bridge on that computer
-- (127.0.0.1 only) for a terminal and a browser; the page reaches it directly, so nothing typed there, passwords
-- included, passes through Longtable. The table keeps only where the bridge listens and its key, and hands them only
-- to the person themselves, only while their AI runs as their full Claude Code (which can already run commands on that
-- computer with their approval). Also a fifth way for it to ask: bypass, which asks about nothing.

alter table public.connections add column local jsonb;
-- Never readable through the API, never on a live channel: only `my_local` hands it out, to its own person.
revoke select (local) on public.connections from authenticated;

CREATE OR REPLACE FUNCTION public.broadcast_connection_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  rec jsonb := jsonb_build_object('table', 'connections', 'record', to_jsonb(new) - 'token_hash' - 'commands' - 'local');
begin
  perform realtime.send(rec, tg_op, 'team:' || new.table_id::text, true);
  if exists (select 1 from public.members m where m.id = new.member_id and m.role = 'client') then
    perform realtime.send(rec, tg_op, 'client:' || new.table_id::text || ':' || new.member_id::text, true);
  end if;
  return null;
end;
$function$;

-- Whether a connection may open its bridge for its person: their own Claude, run as their full Claude Code, for a team
-- member still at the table (never a client, never the test client).
create function public.local_allowed(c public.connections)
returns boolean language sql stable security definer set search_path = '' as $$
  select c.revoked_at is null and c.kind = 'claude' and coalesce(c.full_claude, false)
     and exists (select 1 from public.members m where m.id = c.member_id and m.role in ('owner', 'developer')
                   and m.removed_at is null and not coalesce(m.test, false));
$$;
revoke all on function public.local_allowed(public.connections) from public, anon, authenticated;

-- The connection says where its bridge listens and with which key, at start and every minute; the answer says whether
-- it may serve this table. Written only when it changed, so the minute's call stays quiet on the live channels.
create function public.runner_local(token text, port integer, key text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
  ok boolean := public.local_allowed(c);
  want jsonb;
begin
  if port is null or port not between 1024 and 65535 or key is null or key !~ '^[A-Za-z0-9_-]{32,64}$' then
    raise exception 'a bridge needs a port and a key';
  end if;
  want := case when ok then jsonb_build_object('port', port, 'key', key) end;
  update public.connections set local = want where id = c.id and local is distinct from want;
  return ok;
end;
$$;
revoke all on function public.runner_local(text, integer, text) from public;
grant execute on function public.runner_local(text, integer, text) to anon, authenticated;

-- Their own bridge, for their own page: only while their connection is allowed one and was heard from lately.
create function public.my_local(t uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select c.local from public.connections c join public.members m on m.id = c.member_id
   where c.table_id = t and m.table_id = t and m.user_id = auth.uid() and c.local is not null
     and public.local_allowed(c) and c.last_seen > now() - interval '2 minutes'
   order by c.last_seen desc limit 1;
$$;
revoke all on function public.my_local(uuid) from public, anon;
grant execute on function public.my_local(uuid) to authenticated;

-- Bypass: their full Claude Code runs everything without asking. Theirs alone to pick, like the other four.
alter table public.connections drop constraint connections_mode_check;
alter table public.connections add constraint connections_mode_check check (mode in ('manual', 'acceptEdits', 'auto', 'plan', 'bypass'));

CREATE OR REPLACE FUNCTION public.set_ai_mode(conn uuid, mode text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.connections;
begin
  select * into c from public.connections where id = conn and revoked_at is null;
  if not found or c.member_id is distinct from public.my_member_id(c.table_id) then
    raise exception 'only its own person sets how their AI asks';
  end if;
  if set_ai_mode.mode not in ('manual', 'acceptEdits', 'auto', 'plan', 'bypass') then
    raise exception 'mode is manual, acceptEdits, auto, plan or bypass';
  end if;
  update public.connections set mode = set_ai_mode.mode where id = conn;
end;
$function$;

update public.connect_release set version = '0.1.50', set_at = now();
