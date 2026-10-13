-- A client's message with something attached went to the team before the hourly limit was looked at, so a client
-- could put any number of requests in front of the team by attaching a file to each. The limit is now checked
-- first, for every message.

CREATE OR REPLACE FUNCTION public.client_say(t uuid, body text, files jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
  req uuid;
  has boolean := coalesce(jsonb_array_length(files), 0) > 0;
begin
  -- One of this person's messages at a time, so two sent together cannot both slip under a limit.
  select * into me from public.members where id = public.client_seat(t) for update;
  if not found or me.role <> 'client' then
    raise exception 'only the client asks here';
  end if;
  if char_length(words) = 0 and not has then
    raise exception 'ask for something';
  end if;
  if char_length(words) = 0 then
    words := left((select string_agg(f ->> 'name', ', ') from jsonb_array_elements(files) f), 500);
  end if;
  if public.client_said_lately(me.id) + (select count(*) from public.sandbox_changes c where c.member_id = me.id and c.created_at > now() - interval '1 hour' and not c.test)::integer >= 60 then
    raise exception 'that is a lot of requests in one hour, try again a little later';
  end if;
  -- Something attached is for people to look at: it goes straight to the team as a request, with the files on it.
  if has then
    req := public.pass_on_request(me.id, words, null, null, true);
    perform public.take_files(t, me.id, files, (select r.message_id from public.requests r where r.id = req));
    update public.messages mm set meta = mm.meta || jsonb_build_object('files',
        (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'mime', a.mime, 'size', a.size, 'path', a.path, 'kind', a.kind) order by a.created_at), '[]'::jsonb)
           from public.attachments a where a.message_id = mm.id))
     where mm.id = (select r.message_id from public.requests r where r.id = req);
    update public.requests r set files = (select mm.meta -> 'files' from public.messages mm where mm.id = r.message_id) where r.id = req;
    return jsonb_build_object('request', req);
  end if;
  if char_length(words) > 4000 then
    raise exception 'that is a lot for one message; keep it under 4,000 characters';
  end if;

  select * into sb from public.sandboxes where member_id = me.id and mode = 'sandbox';
  if found then
    -- The team's Claude that speaks for the table, if it is on; else any of the team's Claudes that is.
    select cn.member_id into seat
      from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer')
     where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude' and cn.last_seen > now() - interval '60 seconds'
     order by (cn.member_id = public.final_seat_now(t)) desc, cn.created_at limit 1;
    -- Every change counts against the day, whatever came of it: each one is a run of the team's AI.
    select count(*) into used from public.sandbox_changes c where c.member_id = me.id and c.created_at > now() - interval '24 hours' and not c.test;
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
    -- No assistant of their own: one of the team's AIs that is on right now answers for the team, from what this
    -- client may know. With none on, the words go to the team as before.
    select cn.member_id into seat
      from public.connections cn join public.members m on m.id = cn.member_id and m.role in ('owner', 'developer') and m.removed_at is null
     where cn.table_id = t and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds'
     order by (cn.member_id = public.final_seat_now(t)) desc, cn.created_at limit 1;
    if seat is null then
      return jsonb_build_object('request', public.pass_on_request(me.id, words, null, null, true));
    end if;
    insert into public.client_lines (table_id, member_id, who, body, by_table) values (t, me.id, 'client', words, true) returning id into line;
    insert into public.jobs (table_id, member_id, kind, line_id, subject) values (t, seat, 'client', line, me.id) returning id into job;
    return jsonb_build_object('line', line, 'job', job);
  end if;
  insert into public.client_lines (table_id, member_id, who, body) values (t, me.id, 'client', words) returning id into line;
  insert into public.jobs (table_id, member_id, kind, line_id) values (t, me.id, 'client', line) returning id into job;
  return jsonb_build_object('line', line, 'job', job);
end;
$$;
