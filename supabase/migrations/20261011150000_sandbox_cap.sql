-- How many changes a client's copy takes in a day is the owner's to set: a number, or as many as they like.
alter table public.table_sandbox alter column cap drop not null;
alter table public.table_sandbox drop constraint table_sandbox_cap_check;
alter table public.table_sandbox add constraint table_sandbox_cap_check check (cap is null or cap between 1 and 1000);

create or replace function public.set_sandbox_links(t uuid, ours text, cap integer, m uuid default null, theirs text default null, folders text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  ok constant text := '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$';
  clean text;
begin
  if not public.is_owner(t) then
    raise exception 'only the owner sets this';
  end if;
  if nullif(btrim(coalesce(ours, '')), '') is not null and btrim(ours) !~ ok then
    raise exception 'that is not an address that starts with https://';
  end if;
  if nullif(btrim(coalesce(theirs, '')), '') is not null and btrim(theirs) !~ ok then
    raise exception 'that is not an address that starts with https://';
  end if;
  if folders is not null then
    select coalesce(string_agg(f, ', '), '') into clean from (
      select btrim(btrim(x), '/') as f from regexp_split_to_table(folders, '[,\n]') x) y where f <> '';
    if clean ~ '[^A-Za-z0-9._/, -]' or clean ~ '(^|[/ ])\.\.([/, ]|$)' then
      raise exception 'folders are plain paths like apps/web/app, separated by commas';
    end if;
  end if;
  insert into public.table_sandbox (table_id, preview_url, cap, paths)
    values (t, nullif(left(btrim(coalesce(ours, '')), 300), ''), case when cap is null then 20 when cap <= 0 then null else least(1000, cap) end, left(coalesce(clean, ''), 600))
    on conflict (table_id) do update set preview_url = excluded.preview_url, cap = case when set_sandbox_links.cap is null then public.table_sandbox.cap when set_sandbox_links.cap <= 0 then null else least(1000, set_sandbox_links.cap) end,
      paths = case when folders is null then public.table_sandbox.paths else excluded.paths end;
  if m is not null then
    update public.sandboxes set url = nullif(left(btrim(coalesce(theirs, '')), 300), '') where member_id = m and table_id = t;
  end if;
end;
$$;

create or replace function public.client_say(t uuid, body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me public.members;
  words text := btrim(coalesce(body, ''));
  ai public.connections;
  sb public.sandboxes;
  line uuid;
  job uuid;
  seat uuid;
  change uuid;
  used integer;
  most integer;
begin
  -- One of this person's messages at a time, so two sent together cannot both slip under a limit.
  select * into me from public.members where table_id = t and user_id = auth.uid() and removed_at is null for update;
  if not found or me.role <> 'client' then
    raise exception 'only the client asks here';
  end if;
  if char_length(words) = 0 then
    raise exception 'ask for something';
  end if;
  if char_length(words) > 4000 then
    raise exception 'that is a lot for one message; keep it under 4,000 characters';
  end if;
  if public.client_said_lately(me.id) + (select count(*) from public.sandbox_changes c where c.member_id = me.id and c.created_at > now() - interval '1 hour')::integer >= 60 then
    raise exception 'that is a lot of requests in one hour, try again a little later';
  end if;

  select * into sb from public.sandboxes where member_id = me.id and mode = 'sandbox';
  if found then
    -- The team's Claude that speaks for the table, if it is on; else any of the team's Claudes that is.
    select cn.member_id into seat
      from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
     where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
     order by (cn.member_id = public.final_seat_now(t)) desc, cn.created_at limit 1;
    -- Every change counts against the day, whatever came of it: each one is a run of the team's AI.
    select count(*) into used from public.sandbox_changes c where c.member_id = me.id and c.created_at > now() - interval '24 hours';
    -- No number means as many as they like.
    select ts.cap into most from public.table_sandbox ts where ts.table_id = t;
    if seat is not null and (most is null or used < most) then
      insert into public.sandbox_changes (table_id, member_id, words) values (t, me.id, words) returning id into change;
      insert into public.jobs (table_id, member_id, kind, change_id) values (t, seat, 'sandbox', change) returning id into job;
      return jsonb_build_object('change', change, 'left', most - used - 1);
    end if;
    -- The sandbox cannot take it right now. The words still reach the team, and the client is told why.
    return jsonb_build_object('request', public.pass_on_request(me.id, words, null, null, true),
      'why', case when seat is null then 'asleep' else 'full' end);
  end if;

  select * into ai from public.connections
   where member_id = me.id and revoked_at is null and last_seen > now() - interval '60 seconds'
   order by last_seen desc limit 1;
  if not found then
    return jsonb_build_object('request', public.pass_on_request(me.id, words, null, null, true));
  end if;
  insert into public.client_lines (table_id, member_id, who, body) values (t, me.id, 'client', words) returning id into line;
  insert into public.jobs (table_id, member_id, kind, line_id) values (t, me.id, 'client', line) returning id into job;
  return jsonb_build_object('line', line, 'job', job);
end;
$$;

create or replace function public.client_sandbox(t uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare
  me public.members;
  sb public.sandboxes;
begin
  select * into me from public.members where table_id = t and user_id = auth.uid() and removed_at is null;
  if not found or me.role <> 'client' then
    raise exception 'only the client has a sandbox';
  end if;
  select * into sb from public.sandboxes where member_id = me.id;
  return jsonb_build_object(
    'on', coalesce(sb.mode = 'sandbox', false),
    'url', sb.url,
    'left', (select greatest(0, ts.cap - (select count(*) from public.sandbox_changes c where c.member_id = me.id and c.created_at > now() - interval '24 hours')::integer)
               from public.table_sandbox ts where ts.table_id = t),
    'changes', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'words', c.words, 'status', c.status, 'summary', c.summary,
                  'verdict', c.verdict, 'note', c.note, 'request_id', c.request_id, 'created_at', c.created_at, 'finished_at', c.finished_at)
                  order by c.created_at desc), '[]'::jsonb)
                  from (select * from public.sandbox_changes x where x.member_id = me.id order by x.created_at desc limit 60) c));
end;
$$;
