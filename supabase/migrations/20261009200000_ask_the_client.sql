-- Step 5, continued: a decision can ask the client first. One option of a decision that tells the client may be a
-- question for them, with two to four answers to tap. Chosen, the question reaches them after the undo window like
-- any answer does. Their tap goes back to the team as a client card, and the request waits on the team again.

alter table public.decision_options add column asks_client boolean not null default false;
alter table public.decision_options add column replies text[] not null default '{}';
alter table public.decision_options add constraint decision_options_replies_check
  check ((asks_client and cardinality(replies) between 2 and 4) or (not asks_client and cardinality(replies) = 0));

alter table public.client_updates add column replies text[] not null default '{}';
alter table public.client_updates add column answer text;
alter table public.client_updates add column answered_at timestamptz;
alter table public.client_updates add column answered_by uuid references public.members (id) on delete set null;

-- A request can wait on the client (question) and come back to the team with their answer (answered).
alter table public.requests drop constraint requests_status_check;
alter table public.requests add constraint requests_status_check
  check (status in ('asked', 'being decided', 'question', 'answered', 'decided', 'planned', 'ready to try', 'done'));

create or replace function public.create_decision(c uuid, title text, context text, origin text, affects_client boolean, options jsonb, request uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  t uuid;
  d uuid;
  me uuid;
  n int := jsonb_array_length(coalesce(options, '[]'::jsonb));
  tells boolean := coalesce(affects_client, false) or request is not null;
  i int;
  o jsonb;
  asking boolean;
  answers text[];
  questions int := 0;
begin
  select ch.table_id into t from public.chats ch where ch.id = c;
  if t is null or not public.is_team(t) then
    raise exception 'only the team can ask for a decision';
  end if;
  if n < 2 or n > 4 then
    raise exception 'a decision needs two to four options';
  end if;
  if request is not null and not exists (select 1 from public.requests r where r.id = request and r.table_id = t) then
    raise exception 'that request is not at this table';
  end if;
  me := public.my_member_id(t);
  insert into public.decisions (table_id, chat_id, title, context, origin, affects_client, created_by, request_id)
    values (t, c, btrim(title), btrim(coalesce(context, '')), btrim(coalesce(origin, '')), tells, me, request)
    returning id into d;
  for i in 0 .. n - 1 loop
    o := options -> i;
    asking := coalesce((o ->> 'asks_client')::boolean, false);
    answers := '{}';
    if asking then
      questions := questions + 1;
      if not tells then
        raise exception 'only a decision the client hears can ask them a question';
      end if;
      if btrim(coalesce(o ->> 'client_words', '')) = '' then
        raise exception 'write the question the client will be asked';
      end if;
      select coalesce(array_agg(btrim(x) order by ord), '{}') into answers
        from jsonb_array_elements_text(coalesce(o -> 'replies', '[]'::jsonb)) with ordinality as e(x, ord)
       where btrim(x) <> '';
      if cardinality(answers) not between 2 and 4 or exists (select 1 from unnest(answers) x where char_length(x) > 60) then
        raise exception 'a question for the client needs two to four short answers';
      end if;
      if (select count(distinct lower(x)) from unnest(answers) x) <> cardinality(answers) then
        raise exception 'the answers to a question must differ';
      end if;
    end if;
    insert into public.decision_options (decision_id, position, label, recommended, client_words, asks_client, replies)
      values (d, i + 1, btrim(o ->> 'label'), coalesce((o ->> 'recommended')::boolean, false),
              case when tells then btrim(coalesce(o ->> 'client_words', '')) else '' end, asking, answers);
  end loop;
  if questions > 1 then
    raise exception 'a decision can ask the client one question';
  end if;
  -- A new request, a follow-up on one already decided, or one the client has just answered goes back to being
  -- decided. One waiting on the client's answer, planned, ready to try or done keeps its status.
  if request is not null then
    update public.requests set status = 'being decided', updated_at = now()
     where id = request and status in ('asked', 'decided', 'answered');
    if found then
      perform public.add_request_event(request, 'The team is deciding');
    end if;
  end if;
  perform public.log_activity(t, me, 'decision.created', d, jsonb_build_object('title', btrim(title)));
  return d;
end;
$$;

-- Delivery: a chosen question reaches the client with its answers to tap, and the request waits on them.
create or replace function public.deliver_due()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  dec public.decisions;
  words text;
  asking boolean;
  answers text[];
  n integer := 0;
begin
  for dec in
    select * from public.decisions
     where status = 'decided' and delivered_at is null and deliver_after <= now()
     order by deliver_after
     for update skip locked
  loop
    select btrim(client_words), asks_client, replies into words, asking, answers
      from public.decision_options where decision_id = dec.id and position = dec.chosen;
    if dec.affects_client and coalesce(words, '') <> '' then
      insert into public.client_updates (table_id, decision_id, request_id, body, replies)
        values (dec.table_id, dec.id, dec.request_id, words, case when asking then answers else '{}' end);
    end if;
    if dec.request_id is not null then
      if asking then
        update public.requests set status = 'question', updated_at = now() where id = dec.request_id;
        perform public.add_request_event(dec.request_id, 'The team has a question for you');
      else
        update public.requests set status = 'decided', updated_at = now() where id = dec.request_id;
        perform public.add_request_event(dec.request_id, coalesce(nullif(words, ''), 'The team decided'));
      end if;
    end if;
    update public.decisions set delivered_at = now() where id = dec.id;
    perform public.log_activity(dec.table_id, null, 'decision.delivered', dec.id,
      jsonb_build_object('title', dec.title, 'told_client', dec.affects_client, 'asked_client', coalesce(asking, false)));
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.deliver_due() from public, anon, authenticated;

-- The client answers with one tap. Only a client who could see the question may answer it, and only once. The
-- answer goes to the team as a client card in the decision's chat; the request is with the team again.
create function public.client_reply(u uuid, choice int)
returns void language plpgsql security definer set search_path = '' as $$
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
  select * into me from public.members where table_id = upd.table_id and user_id = auth.uid();
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
$$;
revoke all on function public.client_reply(uuid, int) from public, anon;
grant execute on function public.client_reply(uuid, int) to authenticated;

-- An answered question changes on every screen the client has open.
drop trigger client_updates_broadcast on public.client_updates;
create trigger client_updates_broadcast after insert or update on public.client_updates
  for each row execute function public.broadcast_client_update();
