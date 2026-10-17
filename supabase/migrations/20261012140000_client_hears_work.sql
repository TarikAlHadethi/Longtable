-- A client's assistant may say what is finished and what is under way (12 Oct 2026): the titles of the
-- work the team's AIs took on, and whether each is done. Also: for_team was true for every client job.

CREATE OR REPLACE FUNCTION public.client_job_payload(j jobs)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'job_id', j.id,
    'kind', 'client', 'for_team', j.subject is not null,
    -- What the team's AIs took on at this table, by title only: what is finished and what is under way. The owner
    -- chose to let a client hear this. Nothing of how it was done, who asked, or what was said about it.
    'work', coalesce((
      select jsonb_agg(jsonb_build_object('title', public.hide_secrets(left(w.title, 120)), 'status', w.status) order by w.created_at desc)
        from (select * from public.tasks t2 where t2.table_id = j.table_id and t2.status in ('working', 'done') order by t2.created_at desc limit 30) w), '[]'::jsonb),
    'table_name', (select name from public.tables where id = j.table_id),
    'me', (select display_name from public.members where id = coalesce(j.subject, j.member_id)),
    'question', (select body from public.client_lines where id = j.line_id),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'title', r.title, 'status', r.status, 'asked', r.created_at,
               'timeline', coalesce((select jsonb_agg(e.label order by e.id) from public.request_events e where e.request_id = r.id), '[]'::jsonb))
             order by r.created_at desc)
        from (select * from public.requests r2 where r2.member_id = coalesce(j.subject, j.member_id) order by r2.created_at desc limit 30) r), '[]'::jsonb),
    'told', coalesce((
      select jsonb_agg(jsonb_build_object('when', u.created_at, 'words', u.body, 'their_answer', u.answer) order by u.created_at desc)
        from (select * from public.client_updates u2
               where u2.table_id = j.table_id
                 and (u2.request_id is null or exists (select 1 from public.requests r3 where r3.id = u2.request_id and r3.member_id = coalesce(j.subject, j.member_id)))
               order by u2.created_at desc limit 30) u), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('who', l.who, 'body', l.body) order by l.created_at)
        from (select * from public.client_lines l2 where l2.member_id = coalesce(j.subject, j.member_id) and l2.id <> j.line_id
               order by l2.created_at desc limit 20) l), '[]'::jsonb));
$function$;
