-- The rule checker for the database chaos run (tests/e2e/chaos-db.mjs): what must always be true of Longtable's
-- data, one function that reads everything and returns one line per broken rule, each starting with the rule's
-- name from sweep-notes/rules.md. Installed into its own schema "chaos" on a test database only, and dropped
-- again at the end. Nothing here is ever part of the product.

create schema if not exists chaos;

-- Act as a person (or as a connection, with no one): the same identity a signed-in browser or the connection's
-- key gives, so row security and every function's own checks apply. One call, one transaction, as the API does.
-- q is one statement that returns one jsonb value. A refusal comes back as {error, state}, never as a failure.
create or replace function chaos.act(uid uuid, q text) returns jsonb language plpgsql as $f$
declare r jsonb;
begin
  begin
    if uid is null then
      perform set_config('request.jwt.claims', '{"role":"anon"}', true);
      perform set_config('role', 'anon', true);
    else
      perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
    end if;
    execute q into r;
    perform set_config('role', 'postgres', true);
    return jsonb_build_object('ok', coalesce(r, 'null'::jsonb));
  exception when others then
    return jsonb_build_object('error', sqlerrm, 'state', sqlstate);
  end;
end $f$;

-- What each person can read, checked as that person. P1 (a client reads nothing of the team side), P2 (clients never
-- read each other), P3 and P4 (nobody reads a table they are not at now, removed people included), and the team never
-- reads a client's private chat with an assistant the client connected themselves.
create or replace function chaos.wall() returns setof text language plpgsql as $f$
declare
  u record;
  rel text;
  n bigint;
  mine uuid[];
  seats uuid[];
  team_tables uuid[];
  client_tables uuid[];
  scoped text[] := array['members','chats','messages','decisions','activity','tasks','notes','jobs','connections','requests',
    'request_events','client_lines','client_updates','sandboxes','sandbox_changes','attachments','round_materials','table_sandbox'];
  team_only text[] := array['chats','messages','decisions','activity','tasks','notes','sandboxes','sandbox_changes','table_sandbox'];
begin
  for u in select distinct user_id from public.members where user_id is not null loop
    select coalesce(array_agg(table_id) filter (where removed_at is null), '{}'),
           coalesce(array_agg(id) filter (where removed_at is null), '{}'),
           coalesce(array_agg(table_id) filter (where removed_at is null and role <> 'client'), '{}'),
           coalesce(array_agg(table_id) filter (where removed_at is null and role = 'client'), '{}')
      into mine, seats, team_tables, client_tables
      from public.members where user_id = u.user_id;
    perform set_config('request.jwt.claims', json_build_object('sub', u.user_id, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    for rel in select unnest(scoped) loop
      execute format('select count(*) from public.%I where not (table_id = any($1))', rel) into n using mine;
      if n > 0 then return next format('P3 user %s reads %s rows of %s at a table they are not at', u.user_id, n, rel); end if;
    end loop;
    select count(*) into n from public.tables where not (id = any(mine));
    if n > 0 then return next format('P3 user %s reads %s tables they are not at', u.user_id, n); end if;
    -- As a client: nothing of the team's, and nothing of another client's.
    for rel in select unnest(team_only) loop
      execute format('select count(*) from public.%I where table_id = any($1) and not (table_id = any($2))', rel) into n using client_tables, team_tables;
      if n > 0 then return next format('P1 client user %s reads %s rows of %s', u.user_id, n, rel); end if;
    end loop;
    select count(*) into n from public.decision_options o join public.decisions d on d.id = o.decision_id where d.table_id = any(client_tables) and not (d.table_id = any(team_tables));
    if n > 0 then return next format('P1 client user %s reads %s decision options', u.user_id, n); end if;
    select count(*) into n from public.jobs where table_id = any(client_tables) and not (table_id = any(team_tables)) and not (member_id = any(seats));
    if n > 0 then return next format('P1 client user %s reads %s jobs that are not theirs', u.user_id, n); end if;
    select count(*) into n from public.connections where table_id = any(client_tables) and not (table_id = any(team_tables)) and not (member_id = any(seats));
    if n > 0 then return next format('P1 client user %s reads %s connections that are not theirs', u.user_id, n); end if;
    select count(*) into n from public.requests where table_id = any(client_tables) and not (table_id = any(team_tables)) and not (member_id = any(seats));
    if n > 0 then return next format('P2 client user %s reads %s requests of another client', u.user_id, n); end if;
    select count(*) into n from public.request_events e where e.table_id = any(client_tables) and not (e.table_id = any(team_tables))
      and not exists (select 1 from public.requests r where r.id = e.request_id and r.member_id = any(seats));
    if n > 0 then return next format('P2 client user %s reads %s request events of another client', u.user_id, n); end if;
    select count(*) into n from public.client_lines where table_id = any(client_tables) and not (table_id = any(team_tables)) and not (member_id = any(seats));
    if n > 0 then return next format('P2 client user %s reads %s chat lines of another client', u.user_id, n); end if;
    select count(*) into n from public.attachments where table_id = any(client_tables) and not (table_id = any(team_tables)) and not (member_id = any(seats));
    if n > 0 then return next format('P2 client user %s reads %s attachments of others', u.user_id, n); end if;
    -- As the team: a client's private chat with their own assistant stays theirs.
    select count(*) into n from public.client_lines where table_id = any(team_tables) and not by_table and not (member_id = any(seats));
    if n > 0 then return next format('P1b team user %s reads %s private chat lines of a client', u.user_id, n); end if;
    select count(*) into n from public.jobs where table_id = any(team_tables) and kind = 'client' and not (member_id = any(seats));
    if n > 0 then return next format('P1b team user %s reads %s client jobs that are not theirs', u.user_id, n); end if;
    perform set_config('role', 'postgres', true);
  end loop;
end $f$;

-- Everything that must be true of the data itself, read as the database's owner.
create or replace function chaos.broken() returns setof text language sql as $f$
  -- O1: one owner per table, and at the table.
  select format('O1 table %s has %s owners at the table', t.id, count(m.id)) from public.tables t
    left join public.members m on m.table_id = t.id and m.role = 'owner' and m.removed_at is null group by t.id having count(m.id) <> 1
  union all select format('O1b table %s has an owner who was removed', m.table_id) from public.members m where m.role = 'owner' and m.removed_at is not null
  -- O3: one live connection per person.
  union all select format('O3 member %s has %s live connections', member_id, count(*)) from public.connections where revoked_at is null group by member_id having count(*) > 1
  -- O5: one plan and one table's answer per round (a Stop marker is not an answer).
  union all select format('O5 round %s has %s plans', round, count(*)) from public.jobs where kind = 'plan' and round is not null group by round having count(*) > 1
  union all select format('O5 round %s has %s answers', round, count(*)) from public.jobs where kind = 'combine' and round is not null and not (status = 'skipped' and coalesce(error, '') like 'stopped by%') group by round having count(*) > 1
  -- O6, E6, E7: a job's fields agree with its status; attempts stay 0 to 3.
  union all select format('O6 running job %s (%s) has no %s', id, kind, case when lease_until is null then 'lease' when connection_id is null then 'connection' else 'start time' end) from public.jobs
    where status = 'running' and (lease_until is null or connection_id is null or started_at is null)
  union all select format('E6 job %s has %s attempts', id, attempts) from public.jobs where attempts < 0 or attempts > 3
  union all select format('E7 finished job %s (%s, %s) still holds a lease', id, kind, status) from public.jobs where status in ('done', 'failed', 'skipped') and lease_until is not null
  union all select format('E7 done job %s (%s) has no finish time', id, kind) from public.jobs where status = 'done' and finished_at is null
  union all select format('X1 %s job %s (%s) has no reason', status, id, kind) from public.jobs where status in ('failed', 'skipped') and coalesce(error, '') = ''
  -- O7: every task's branch is a plain longtable/ name, one per task.
  union all select format('O7 task %s has branch %s', id, branch) from public.tasks where branch !~ '^longtable/[a-z0-9][a-z0-9-]{0,79}$'
  union all select format('O7 branch %s is %s tasks', branch, count(*)) from public.tasks group by table_id, branch having count(*) > 1
  -- O10: a question is answered once, with both its answer and its time.
  union all select format('O10 update %s has an answer and a time that disagree', id) from public.client_updates where (answer is null) <> (answered_at is null)
  -- O11: at most one open listen per person per chat.
  union all select format('O11 %s open listens for one person in chat %s', count(*), j.chat_id) from public.jobs j join public.messages q on q.id = j.question_id
    where j.kind = 'listen' and j.status in ('queued', 'running') group by j.chat_id, q.member_id having count(*) > 1
  -- D1: everything a row points at is at the same table.
  union all select format('D1 job %s is for member %s of another table', j.id, j.member_id) from public.jobs j join public.members m on m.id = j.member_id where m.table_id <> j.table_id
  union all select format('D1 job %s is about member %s of another table', j.id, j.subject) from public.jobs j join public.members m on m.id = j.subject where m.table_id <> j.table_id
  union all select format('D1 job %s is in chat %s of another table', j.id, j.chat_id) from public.jobs j join public.chats c on c.id = j.chat_id where c.table_id <> j.table_id
  union all select format('D1 task %s is in chat %s of another table', t.id, t.chat_id) from public.tasks t join public.chats c on c.id = t.chat_id where c.table_id <> t.table_id
  union all select format('D1 decision %s is about request %s of another table', d.id, d.request_id) from public.decisions d join public.requests r on r.id = d.request_id where r.table_id <> d.table_id
  union all select format('D1 change %s made request %s of another table', s.id, s.request_id) from public.sandbox_changes s join public.requests r on r.id = s.request_id where r.table_id <> s.table_id
  union all select format('D1 table %s has its client chat at another table', t.id) from public.tables t join public.chats c on c.id = t.client_chat where c.table_id <> t.id
  union all select format('D1 %s %s is by member %s of another table', x.kind, x.id, x.member_id) from (
      select 'message' kind, id, table_id, member_id from public.messages union all select 'request', id, table_id, member_id from public.requests
      union all select 'line', id, table_id, member_id from public.client_lines union all select 'connection', id, table_id, member_id from public.connections
      union all select 'change', id, table_id, member_id from public.sandbox_changes) x
    join public.members m on m.id = x.member_id where m.table_id <> x.table_id
  -- D7: the final seat is on the team and at the table.
  union all select format('D7 table %s has final seat %s, who is %s', t.id, t.final_seat, case when m.removed_at is not null then 'removed' when m.table_id <> t.id then 'at another table' else m.role::text end)
    from public.tables t join public.members m on m.id = t.final_seat where m.removed_at is not null or m.table_id <> t.id or m.role = 'client'
  -- D2: a decision's fields agree with its status.
  union all select format('D2 open decision %s has something chosen or timed', id) from public.decisions where status = 'open' and (chosen is not null or decided_at is not null or deliver_after is not null or delivered_at is not null)
  union all select format('D2 decided decision %s has %s', id, case when chosen is null then 'nothing chosen' else 'no time' end) from public.decisions where status = 'decided' and (chosen is null or decided_at is null or deliver_after is null)
  union all select format('D2 decision %s chose option %s, which is not one of its own', d.id, d.chosen) from public.decisions d where d.chosen is not null and not exists (select 1 from public.decision_options o where o.decision_id = d.id and o.position = d.chosen)
  union all select format('D2 decision %s was delivered while %s', id, status) from public.decisions where delivered_at is not null and status <> 'decided'
  -- D3: a request being decided has a decision behind it. (A question already sent stays the client's to answer
  -- even when its decision's chat is deleted.)
  union all select format('D3 request %s says "%s" with no decision behind it', r.id, r.status) from public.requests r
    where r.status = 'being decided' and not exists (select 1 from public.decisions d where d.request_id = r.id)
  -- D4: what a client is told from a decision is the chosen option's client words.
  union all select format('D4 update %s says something other than the chosen words of decision %s', u.id, u.decision_id) from public.client_updates u
    join public.decisions d on d.id = u.decision_id join public.decision_options o on o.decision_id = d.id and o.position = d.chosen
    where u.decision_id is not null and u.body <> o.client_words and u.body not like 'Thanks, passed on%'
  -- D5 (the daily cap) is checked by the harness at the moment a change is taken: the cap may change later.
  -- D8: a task's status and finish time agree.
  union all select format('D8 task %s is %s %s a finish time', id, status, case when finished_at is null then 'without' else 'with' end) from public.tasks
    where (status = 'working') <> (finished_at is null)
  -- D9: only a ready change of a client's is judged, and taking it always makes a task.
  union all select format('D9 change %s was judged "%s" while %s%s', id, verdict, status, case when test then ', a test' else '' end) from public.sandbox_changes where verdict is not null and (status <> 'ready' or test)
  union all select format('D9 change %s was taken with no task', id) from public.sandbox_changes where verdict = 'take' and task_id is null
  -- D10: what is shared for one request stays small.
  union all select format('D10 %s files and %s characters shared for one request', count(*), sum(length(body))) from public.round_materials group by question_id, member_id having count(*) > 8 or sum(length(body)) > 360000
  -- D11: an invite is used once, and both halves of that say so.
  union all select format('D11 invite %s is half used', id) from public.invites where (used_at is null) <> (used_by is null)
  -- P4: a removed person has no live connection, no open job, and nothing new written as them or for them.
  union all select format('P4 removed member %s still has a live connection', c.member_id) from public.connections c join public.members m on m.id = c.member_id where m.removed_at is not null and c.revoked_at is null
  union all select format('P4 removed member %s still has %s job %s', j.member_id, j.status, j.kind) from public.jobs j join public.members m on m.id = j.member_id where m.removed_at is not null and j.status in ('queued', 'running', 'waiting')
  union all select format('P4 job %s (%s) is still %s for removed member %s', j.id, j.kind, j.status, j.subject) from public.jobs j join public.members m on m.id = j.subject where m.removed_at is not null and j.status in ('queued', 'running', 'waiting')
  union all select format('P4 %s %s was written for member %s after they were removed', x.kind, x.id, x.member_id) from (
      select 'line' kind, id, member_id, created_at from public.client_lines union all select 'request', id, member_id, created_at from public.requests
      union all select 'message', id, member_id, created_at from public.messages where not by_ai) x
    -- A write that raced the removal itself may carry a start time a moment after it and still have been first; the
    -- harness plays that race on purpose. Anything later than that is written for someone already gone.
    join public.members m on m.id = x.member_id where m.removed_at is not null and x.created_at > m.removed_at + interval '50 milliseconds'
  -- P8: nothing a connection wrote holds a key shape the table hides.
  union all select format('P8 %s %s holds a key shape starting %s', x.kind, x.id, left(substring(x.t from '(sk-ant-|sb_secret_|ghp_|github_pat_|AKIA)'), 12)) from (
      select 'AI message' kind, id, body t from public.messages where by_ai union all select 'task', id, coalesce(title, '') || ' ' || coalesce(result, '') from public.tasks
      union all select 'job note', id, coalesce(progress, '') || ' ' || coalesce(error, '') from public.jobs
      union all select 'assistant line', id, body from public.client_lines where who <> 'client'
      union all select 'change', id, coalesce(summary, '') || ' ' || coalesce(detail, '') from public.sandbox_changes
      union all select 'note', id, body from public.notes) x
    where x.t ~ '(sk-ant-[A-Za-z0-9_-]{8,}|sb_secret_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})'
  -- B4: the hourly limit on what a client says holds.
  union all select format('B4 client %s said %s things in an hour', x.member_id, count(*)) from (
      select member_id from public.requests where from_line is null and created_at > now() - interval '1 hour'
      union all select member_id from public.client_lines where who = 'client' and created_at > now() - interval '1 hour') x
    group by x.member_id having count(*) > 60
$f$;

-- E1 to E5: once every computer is gone and every clock has run past every limit, nothing is left open.
create or replace function chaos.unsettled() returns setof text language sql as $f$
  select format('E1 %s job %s (%s) is still %s', case when j.round is null then 'a' else 'a round''s' end, j.id, j.kind, j.status) from public.jobs j where j.status in ('queued', 'running', 'waiting')
  union all select format('E2 task %s is still working', id) from public.tasks where status = 'working'
  union all select format('E3 change %s is still being built', id) from public.sandbox_changes where status = 'working'
  union all select format('E5 decision %s is decided and past its undo window, but was never delivered', id) from public.decisions where status = 'decided' and delivered_at is null and deliver_after < now()
  union all select format('E4 a client''s line %s got neither an answer nor a request', c.id) from public.client_lines c
    join public.members cm on cm.id = c.member_id and cm.removed_at is null
    where c.who = 'client' and c.request_id is null
      and not exists (select 1 from public.client_lines a where a.member_id = c.member_id and a.who <> 'client' and a.created_at >= c.created_at)
      and not exists (select 1 from public.requests r where r.from_line = c.id)
$f$;
