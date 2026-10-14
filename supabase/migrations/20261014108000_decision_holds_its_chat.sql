-- A decision made in a chat that was being deleted at the same moment failed with a raw foreign-key error. The chat is
-- now held while the decision is made: the deletion waits for it, or the decision finds the chat gone and says so.
-- Found by the chaos run (rule Q2, a deletion and a decision raced from two sessions).

CREATE OR REPLACE FUNCTION public.create_decision(c uuid, title text, context text, origin text, affects_client boolean, options jsonb, request uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- The chat is held while the decision is made, so one deleted at that very moment refuses it in words.
  select ch.table_id into t from public.chats ch where ch.id = c for share;
  if t is null or not public.is_team(t) then
    raise exception 'only the team can ask for a decision';
  end if;
  if n < 2 or n > 4 then
    raise exception 'a decision needs two to four options';
  end if;
  if char_length(btrim(coalesce(title, ''))) not between 1 and 140 then
    raise exception 'a decision needs a title of up to 140 characters';
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
$function$;
