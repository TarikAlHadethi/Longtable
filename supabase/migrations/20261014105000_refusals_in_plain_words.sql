-- Four ways of being turned down answered with a raw database error instead of a plain sentence: a chat name over 60
-- characters or what it is about over 140, a bubble colour that is not one of the twelve, a decision title over 140,
-- and asking the table something over 8,000 characters. The table's own limits refused them all the same; now the
-- function says what is wrong, before anything is written. Found by the chaos run (rule Q2).

CREATE OR REPLACE FUNCTION public.create_chat(t uuid, chat_name text, chat_about text DEFAULT ''::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c uuid;
  me uuid := public.my_member_id(t);
begin
  if not public.is_team(t) then
    raise exception 'only the team can make chats';
  end if;
  if char_length(btrim(coalesce(chat_name, ''))) not between 1 and 60 then
    raise exception 'a chat needs a name of up to 60 characters';
  end if;
  if char_length(btrim(coalesce(chat_about, ''))) > 140 then
    raise exception 'what a chat is about takes up to 140 characters';
  end if;
  insert into public.chats (table_id, name, about, created_by) values (t, btrim(chat_name), btrim(coalesce(chat_about, '')), me)
    returning id into c;
  perform public.log_activity(t, me, 'chat.created', c, jsonb_build_object('name', btrim(chat_name)));
  return c;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_profile(t uuid, new_name text, new_color text, new_name_color text, new_avatar text, new_status text, new_bubble text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if new_bubble is not null and new_bubble <> all (array['rose', 'peach', 'sand', 'lime', 'mint', 'teal', 'sky', 'blue', 'iris', 'lilac', 'pink', 'stone']) then
    raise exception 'that is not one of the bubble colours';
  end if;
  if new_bubble is not null and exists (select 1 from public.members m where m.table_id = t and m.bubble = new_bubble and m.id <> me and m.removed_at is null) then
    raise exception 'someone else at the table has that bubble colour';
  end if;
  update public.members
     set display_name = clean,
         color = new_color,
         name_color = nullif(btrim(coalesce(new_name_color, '')), ''),
         avatar = nullif(coalesce(new_avatar, ''), ''),
         status = left(btrim(coalesce(new_status, '')), 80),
         bubble = coalesce(new_bubble, bubble)
   where id = me and removed_at is null;
end;
$function$;

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
  select ch.table_id into t from public.chats ch where ch.id = c;
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

CREATE OR REPLACE FUNCTION public.ask_table(c uuid, body text, files jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  t uuid;
  me uuid;
  q uuid;
  words text := btrim(coalesce(body, ''));
  got jsonb;
begin
  select ch.table_id into t from public.chats ch where ch.id = c;
  if t is null or not public.is_team(t) then
    raise exception 'only the team can ask the table';
  end if;
  me := public.my_member_id(t);
  if char_length(words) = 0 and coalesce(jsonb_array_length(files), 0) = 0 then
    raise exception 'ask something';
  end if;
  if char_length(words) > 8000 then
    raise exception 'that is a lot for one message; keep it under 8,000 characters';
  end if;
  -- A message that is only attachments still needs words to be found by: their names.
  if char_length(words) = 0 then
    words := left((select string_agg(f ->> 'name', ', ') from jsonb_array_elements(files) f), 500);
  end if;
  perform set_config('longtable.asked', '1', true);
  insert into public.messages (table_id, chat_id, member_id, body) values (t, c, me, words) returning id into q;
  if coalesce(jsonb_array_length(files), 0) > 0 then
    got := public.take_files(t, me, files, q);
    update public.messages set meta = meta || jsonb_build_object('files', got) where id = q;
  end if;
  return public.start_round(t, c, q, me);
end;
$function$;
