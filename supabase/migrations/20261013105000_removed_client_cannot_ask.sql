-- A client taken off the table could still put requests in front of the team: the older way of asking looked the
-- caller up without checking they were still at the table.

CREATE OR REPLACE FUNCTION public.client_ask(t uuid, body text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  me public.members;
  words text := btrim(coalesce(body, ''));
begin
  select * into me from public.members where table_id = t and user_id = auth.uid() and removed_at is null;
  if not found or me.role <> 'client' then
    raise exception 'only the client asks here';
  end if;
  if char_length(words) = 0 then
    raise exception 'ask for something';
  end if;
  if public.client_said_lately(me.id) >= 30 then
    raise exception 'that is a lot of requests in one hour, try again a little later';
  end if;
  return public.pass_on_request(me.id, words, null, null, true);
end;
$$;
