-- A client with their own copy asking a question got their copy building it, then "that's a question, I've passed it
-- on". With a copy, every message went to the copy. Now a question goes to the assistant, which answers it (and looks
-- at the code when it must), and only a request to change something goes to the copy.
--
-- is_question is a free check in SQL, no model: a question mark, or a question word at the start (after "ok", "so",
-- "hey" and the like), unless it asks for a change ("can you make the title blue?", "please add a filter"). When it
-- is unsure it says change, as before, and the copy's own AI still hands a question to the team. (\y is a word edge
-- in Postgres patterns.)

create or replace function public.is_question(words text) returns boolean language sql immutable set search_path = '' as $$
  with w as (
    select regexp_replace(lower(btrim(coalesce(words, ''))),
      '^((ok|okay|so|hey|hi|hello|um|uh|and|but|also|well|alright|right|then|quick question|question)[\s,.!:-]+)+', '') as s
  ), c as (
    select s,
      s ~ '^(please\s+)?(make|change|add|remove|delete|put|move|turn|set|show|hide|rename|fix|update|use|swap|replace|switch|give|let|bring|drop|take|increase|decrease|enlarge|shrink|center|centre|align|bold|colou?r|translate|sort|reorder|redesign|style|edit)\y' as orders,
      s ~ '^(can|could|would|will|can''t|cannot)\s+(you|we|u)\s+(please\s+)?(make|change|add|remove|delete|put|move|turn|set|show|hide|rename|fix|update|use|swap|replace|switch|give|let|bring|drop|take|increase|decrease|enlarge|shrink|center|centre|align|bold|colou?r|translate|sort|reorder|redesign|style|edit)\y'
        or s ~ '^(is it possible to|i want|i''d like|i would like|i need|we need|we want)\y' as asks_change
    from w
  )
  select not orders and not asks_change and (
    s ~ '\?\s*$'
    or s ~ '^(what|whats|what''s|wat|how|hows|how''s|when|whens|where|wheres|where''s|why|who|whos|who''s|which|is|isn''t|are|aren''t|am|was|were|do|does|did|don''t|doesn''t|can|could|will|would|should|has|have|any|tell me|explain|remind me)\y'
  ) from c;
$$;
grant execute on function public.is_question(text) to authenticated;

CREATE OR REPLACE FUNCTION public.client_say(t uuid, body text, files jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- Still at the table is checked again once the row is ours: taken off while this waited for it, they are not.
  select * into me from public.members where id = public.client_seat(t) and removed_at is null for update;
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
  -- A question is answered by the assistant, copy or not: only a change goes to the copy.
  if found and not public.is_question(words) then
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
  if not found or coalesce((select cs.answered_by from public.client_settings cs where cs.member_id = me.id), 'own') = 'table' then
    -- The team's assistant answers, from what this client may know. With no team AI on, the words reach the team and
    -- wait for an AI, which answers the moment one comes on (answer_waiting_clients).
    seat := public.client_desk_seat(t);
    insert into public.client_lines (table_id, member_id, who, body, by_table, waiting) values (t, me.id, 'client', words, true, seat is null) returning id into line;
    if seat is null then
      -- Nobody's AI is on: the team still sees it in their chat at once, and an AI answers the client the moment one
      -- comes on.
      perform public.pass_on_request(me.id, words, null, line, false);
      return jsonb_build_object('line', line, 'waiting', true);
    end if;
    insert into public.jobs (table_id, member_id, kind, line_id, subject) values (t, seat, 'client', line, me.id) returning id into job;
    return jsonb_build_object('line', line, 'job', job);
  end if;
  insert into public.client_lines (table_id, member_id, who, body) values (t, me.id, 'client', words) returning id into line;
  insert into public.jobs (table_id, member_id, kind, line_id) values (t, me.id, 'client', line) returning id into job;
  return jsonb_build_object('line', line, 'job', job);
end;
$function$
;
