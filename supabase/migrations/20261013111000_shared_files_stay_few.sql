-- What a connection shares for a request was limited to eight files and 360,000 characters for each call, not for the
-- request, so calling again with new names added rows without end while the job ran. The limits now count what is
-- already kept for that request from that connection.

CREATE OR REPLACE FUNCTION public.runner_share(token text, job uuid, files jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
  q public.messages;
  f jsonb;
  n integer := 0;
  total integer := 0;
  have integer := 0;
begin
  select * into j from public.jobs where id = job and member_id = c.member_id and status = 'running';
  if not found then
    raise exception 'this job is not yours';
  end if;
  select * into q from public.messages where id = j.question_id;
  -- Only what the connection's own person pointed at, and only while they leave sharing on.
  if q.id is null or q.member_id <> c.member_id or not (c.open_paths and c.share_paths) then
    return 0;
  end if;
  -- The limits are for the request, not for one call: what this connection already shared for it counts.
  select count(*), coalesce(sum(char_length(rm.body)), 0) into have, total
    from public.round_materials rm where rm.question_id = q.id and rm.member_id = c.member_id;
  for f in select x from jsonb_array_elements(coalesce(files, '[]'::jsonb)) x limit 8 loop
    continue when char_length(coalesce(f ->> 'name', '')) not between 1 and 400 or char_length(coalesce(f ->> 'body', '')) = 0;
    continue when char_length(f ->> 'body') > 120000 or total + char_length(f ->> 'body') > 360000;
    -- A ninth name is left out; one already shared may still be replaced.
    continue when have >= 8 and not exists (select 1 from public.round_materials rm
      where rm.question_id = q.id and rm.member_id = c.member_id and rm.name = f ->> 'name');
    insert into public.round_materials (table_id, question_id, member_id, name, body)
      values (j.table_id, q.id, c.member_id, f ->> 'name', public.hide_secrets(f ->> 'body'))
      on conflict (question_id, member_id, name) do update set body = excluded.body, created_at = now();
    select count(*) into have from public.round_materials rm where rm.question_id = q.id and rm.member_id = c.member_id;
    total := total + char_length(f ->> 'body');
    n := n + 1;
  end loop;
  return n;
end;
$$;
