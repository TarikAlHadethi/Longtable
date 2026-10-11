-- A test client: a pretend client seat any owner can add to their table, to try the client's side for real before a
-- real client is invited. It has no account behind it. The owner writes as it from the "Client side" view; everything
-- it asks goes through the same doors as a real client's words. Taking it off deletes all it did.

alter table public.members alter column user_id drop not null;
alter table public.members add column test boolean not null default false;
alter table public.members add constraint members_test_shape
  check ((test and user_id is null and role = 'client') or (not test and user_id is not null));
create unique index members_one_test on public.members (table_id) where test;

-- Whose words a client-side call carries: the caller's own client seat, or, for the owner, the table's test client.
create function public.client_seat(t uuid)
returns uuid language sql security definer set search_path = '' stable as $$
  select coalesce(
    (select m.id from public.members m where m.table_id = t and m.user_id = auth.uid() and m.removed_at is null and m.role = 'client'),
    (select x.id from public.members x where x.table_id = t and x.test and x.removed_at is null
       and exists (select 1 from public.members o where o.table_id = t and o.user_id = auth.uid() and o.removed_at is null and o.role = 'owner')));
$$;
revoke all on function public.client_seat(uuid) from public, anon;
grant execute on function public.client_seat(uuid) to authenticated;

create function public.add_test_client(t uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  seat uuid;
begin
  if not exists (select 1 from public.members o where o.table_id = t and o.user_id = auth.uid() and o.removed_at is null and o.role = 'owner') then
    raise exception 'only the owner adds a test client';
  end if;
  select id into seat from public.members where table_id = t and test;
  if found then
    update public.members set removed_at = null where id = seat;
    return seat;
  end if;
  insert into public.members (table_id, user_id, role, display_name, color, test)
    values (t, null, 'client', 'Test client', 'oklch(0.62 0.03 260)', true) returning id into seat;
  return seat;
end;
$$;
revoke all on function public.add_test_client(uuid) from public, anon;
grant execute on function public.add_test_client(uuid) to authenticated;

-- Taking it off removes the seat and everything it asked, was told and had built for it.
create function public.remove_test_client(t uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.members o where o.table_id = t and o.user_id = auth.uid() and o.removed_at is null and o.role = 'owner') then
    raise exception 'only the owner removes the test client';
  end if;
  delete from public.members where table_id = t and test;
end;
$$;
revoke all on function public.remove_test_client(uuid) from public, anon;
grant execute on function public.remove_test_client(uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.client_say(t uuid, body text)
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
begin
  -- One of this person's messages at a time, so two sent together cannot both slip under a limit.
  select * into me from public.members where id = public.client_seat(t) for update;
  if not found or me.role <> 'client' then
    raise exception 'only the client asks here';
  end if;
  if char_length(words) = 0 then
    raise exception 'ask for something';
  end if;
  if char_length(words) > 4000 then
    raise exception 'that is a lot for one message; keep it under 4,000 characters';
  end if;
  if public.client_said_lately(me.id) + (select count(*) from public.sandbox_changes c where c.member_id = me.id and c.created_at > now() - interval '1 hour' and not c.test)::integer >= 60 then
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
    return jsonb_build_object('request', public.pass_on_request(me.id, words, null, null, true));
  end if;
  insert into public.client_lines (table_id, member_id, who, body) values (t, me.id, 'client', words) returning id into line;
  insert into public.jobs (table_id, member_id, kind, line_id) values (t, me.id, 'client', line) returning id into job;
  return jsonb_build_object('line', line, 'job', job);
end;
$function$;

CREATE OR REPLACE FUNCTION public.client_reply(u uuid, choice integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  upd public.client_updates;
  me public.members;
  req public.requests;
  dec public.decisions;
  picked text;
  landing uuid;
begin
  select * into upd from public.client_updates where id = u for update;
  if not found then
    raise exception 'that question is not here';
  end if;
  select * into me from public.members where id = public.client_seat(upd.table_id);
  if not found or me.role <> 'client' then
    raise exception 'only the client answers here';
  end if;
  if upd.request_id is not null then
    select * into req from public.requests where id = upd.request_id;
    if req.member_id <> me.id then
      raise exception 'that question is not here';
    end if;
  end if;
  if cardinality(upd.replies) = 0 then
    raise exception 'that is not a question';
  end if;
  if upd.answer is not null then
    raise exception 'already answered';
  end if;
  if choice is null or choice < 1 or choice > cardinality(upd.replies) then
    raise exception 'pick one of the answers';
  end if;
  picked := upd.replies[choice];
  update public.client_updates set answer = picked, answered_at = now(), answered_by = me.id where id = u;
  select * into dec from public.decisions where id = upd.decision_id;
  landing := coalesce(dec.chat_id,
    (select coalesce(tb.client_chat, (select ch.id from public.chats ch where ch.table_id = upd.table_id and ch.is_general))
       from public.tables tb where tb.id = upd.table_id));
  insert into public.messages (table_id, chat_id, member_id, body, kind, meta)
    values (upd.table_id, landing, me.id, picked, 'client',
            jsonb_build_object('request', upd.request_id, 'answers', upd.decision_id, 'question', upd.body));
  if req.id is not null then
    update public.requests set status = 'answered', updated_at = now() where id = req.id;
    perform public.add_request_event(req.id, 'You answered: ' || picked);
  end if;
  insert into public.client_updates (table_id, request_id, body)
    values (upd.table_id, upd.request_id, 'Thanks, passed on to the team.');
  perform public.log_activity(upd.table_id, me.id, 'client.answered', coalesce(req.id, upd.id), jsonb_build_object('answer', picked));
end;
$function$;

CREATE OR REPLACE FUNCTION public.client_sandbox(t uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me public.members;
  sb public.sandboxes;
begin
  select * into me from public.members where id = public.client_seat(t);
  if not found or me.role <> 'client' then
    raise exception 'only the client has a sandbox';
  end if;
  select * into sb from public.sandboxes where member_id = me.id;
  return jsonb_build_object(
    'on', coalesce(sb.mode = 'sandbox', false),
    'url', sb.url,
    'left', (select greatest(0, ts.cap - (select count(*) from public.sandbox_changes c where c.member_id = me.id and c.created_at > now() - interval '24 hours' and not c.test)::integer)
               from public.table_sandbox ts where ts.table_id = t),
    'changes', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'words', c.words, 'status', c.status, 'summary', c.summary,
                  'verdict', c.verdict, 'note', c.note, 'request_id', c.request_id, 'created_at', c.created_at, 'finished_at', c.finished_at)
                  order by c.created_at desc), '[]'::jsonb)
                  from (select * from public.sandbox_changes x where x.member_id = me.id and not x.test order by x.created_at desc limit 60) c));
end;
$function$;
