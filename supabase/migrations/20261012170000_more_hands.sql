-- More hands (12 Oct 2026): what a person points at on their own computer can be shared with the other AIs on the
-- same request; messages carry attachments; a person's own AI commands are known to the table, so "/" can offer
-- them; and each connection has its own switches.

alter table public.connections add column share_paths boolean not null default true;
alter table public.connections add column commands jsonb not null default '[]'::jsonb;

-- The switches on a person's own connection.
create function public.set_connection_options(conn uuid, open boolean, share boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  cn public.connections;
begin
  select * into cn from public.connections where id = conn and revoked_at is null for update;
  if not found or cn.member_id <> public.my_member_id(cn.table_id) then
    raise exception 'these are yours to set only for your own AI';
  end if;
  update public.connections set open_paths = coalesce(open, open_paths), share_paths = coalesce(share, share_paths) where id = conn;
end;
$$;
revoke all on function public.set_connection_options(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_connection_options(uuid, boolean, boolean) to authenticated;

-- The commands and skills a person's AI has on their own computer: names and one line each, never their contents.
create function public.runner_commands(token text, list jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
  clean jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', left(x ->> 'name', 60),
           'about', left(public.hide_secrets(coalesce(x ->> 'about', '')), 200),
           'kind', case when x ->> 'kind' in ('command', 'skill', 'prompt') then x ->> 'kind' else 'command' end)), '[]'::jsonb)
    into clean
    from (select x from jsonb_array_elements(coalesce(list, '[]'::jsonb)) x
           where x ->> 'name' ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,59}$' limit 150) s;
  update public.connections set commands = clean where id = c.id;
  return jsonb_array_length(clean);
end;
$$;
revoke all on function public.runner_commands(text, jsonb) from public;
grant execute on function public.runner_commands(text, jsonb) to anon, authenticated;

-- What one person's AI read from their own computer for a request, kept for the other AIs on that same request.
-- Text only, small, secrets hidden, gone after a week. Nobody reads this table directly.
create table public.round_materials (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  question_id uuid not null references public.messages (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 400),
  body text not null check (char_length(body) <= 120000),
  created_at timestamptz not null default now(),
  unique (question_id, member_id, name)
);
alter table public.round_materials enable row level security;

create function public.runner_share(token text, job uuid, files jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
  q public.messages;
  f jsonb;
  n integer := 0;
  total integer := 0;
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
  for f in select x from jsonb_array_elements(coalesce(files, '[]'::jsonb)) x limit 8 loop
    continue when char_length(coalesce(f ->> 'name', '')) not between 1 and 400 or char_length(coalesce(f ->> 'body', '')) = 0;
    continue when char_length(f ->> 'body') > 120000 or total + char_length(f ->> 'body') > 360000;
    insert into public.round_materials (table_id, question_id, member_id, name, body)
      values (j.table_id, q.id, c.member_id, f ->> 'name', public.hide_secrets(f ->> 'body'))
      on conflict (question_id, member_id, name) do update set body = excluded.body, created_at = now();
    total := total + char_length(f ->> 'body');
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.runner_share(text, uuid, jsonb) from public;
grant execute on function public.runner_share(text, uuid, jsonb) to anon, authenticated;

select cron.schedule('longtable-forget-materials', '41 3 * * *', $$delete from public.round_materials where created_at < now() - interval '7 days'$$);

-- Attachments: pictures, files, video and voice on a message. The bytes live in storage, under the table's own
-- folder and the uploader's; the row here says what each is.
insert into storage.buckets (id, name, public, file_size_limit) values ('attachments', 'attachments', false, 26214400)
  on conflict (id) do update set public = false, file_size_limit = 26214400;

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  message_id uuid references public.messages (id) on delete cascade,
  path text not null unique,
  name text not null check (char_length(name) between 1 and 200),
  mime text not null default 'application/octet-stream',
  size bigint not null default 0,
  kind text not null check (kind in ('image', 'video', 'audio', 'file')),
  created_at timestamptz not null default now()
);
create index attachments_message_idx on public.attachments (message_id);
alter table public.attachments enable row level security;
create policy "the team sees what is attached at its table" on public.attachments for select to authenticated
  using (public.is_team(table_id));
create policy "a person sees what they attached" on public.attachments for select to authenticated
  using (member_id = public.my_member_id(table_id));

-- Where an AI fetches an attachment from: a signed address made by the person who uploaded it. Never read directly.
create table public.attachment_links (
  attachment_id uuid primary key references public.attachments (id) on delete cascade,
  url text not null
);
alter table public.attachment_links enable row level security;

alter table public.requests add column files jsonb not null default '[]'::jsonb;

-- Who may put a file where: only in their own folder of a table they are at. Who may read: the team reads
-- everything at its table; anyone reads their own.
create policy "attach in your own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.my_member_id(((storage.foldername(name))[1])::uuid)::text = (storage.foldername(name))[2]);
create policy "the team reads its table's attachments" on storage.objects for select to authenticated
  using (bucket_id = 'attachments'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and (public.is_team(((storage.foldername(name))[1])::uuid)
      or public.my_member_id(((storage.foldername(name))[1])::uuid)::text = (storage.foldername(name))[2]));

-- Takes what was uploaded for a message: checks each file is really there, in the caller's own folder at this table,
-- and writes it down. "owner" is whose message it is (the test client's, when the owner is acting as one).
create function public.take_files(t uuid, owner uuid, files jsonb, msg uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me uuid := public.my_member_id(t);
  f jsonb;
  o record;
  made uuid;
  mime text;
  out jsonb := '[]'::jsonb;
  n integer := 0;
begin
  if me is null then
    raise exception 'you are not at this table';
  end if;
  for f in select x from jsonb_array_elements(coalesce(files, '[]'::jsonb)) x loop
    n := n + 1;
    if n > 10 then
      raise exception 'ten attachments at most in one message';
    end if;
    if coalesce(f ->> 'path', '') !~ ('^' || t::text || '/' || me::text || '/[0-9a-f-]{36}-[^/]{1,200}$') then
      raise exception 'that attachment is not yours';
    end if;
    select so.id, so.metadata into o from storage.objects so where so.bucket_id = 'attachments' and so.name = f ->> 'path';
    if not found then
      raise exception 'that attachment did not finish uploading';
    end if;
    -- The address an AI will fetch it from must be this very file's signed address, nothing else.
    if position('/storage/v1/object/sign/attachments/' || replace(f ->> 'path', ' ', '%20') || '?token=' in coalesce(f ->> 'url', '')) = 0
       and position('/storage/v1/object/sign/attachments/' || (f ->> 'path') || '?token=' in coalesce(f ->> 'url', '')) = 0 then
      raise exception 'that attachment has no address';
    end if;
    mime := left(coalesce(nullif(o.metadata ->> 'mimetype', ''), f ->> 'mime', 'application/octet-stream'), 120);
    insert into public.attachments (table_id, member_id, message_id, path, name, mime, size, kind)
      values (t, owner, msg, f ->> 'path', left(coalesce(nullif(btrim(f ->> 'name'), ''), 'file'), 200), mime,
              coalesce((o.metadata ->> 'size')::bigint, 0),
              case when mime like 'image/%' then 'image' when mime like 'video/%' then 'video' when mime like 'audio/%' then 'audio' else 'file' end)
      returning id into made;
    insert into public.attachment_links (attachment_id, url) values (made, f ->> 'url');
    out := out || (select jsonb_build_object('id', a.id, 'name', a.name, 'mime', a.mime, 'size', a.size, 'path', a.path, 'kind', a.kind) from public.attachments a where a.id = made);
  end loop;
  return out;
end;
$$;
revoke all on function public.take_files(uuid, uuid, jsonb, uuid) from public, anon, authenticated;

drop function public.ask_table(uuid, text);
drop function public.client_say(uuid, text);

CREATE OR REPLACE FUNCTION public.runner_claim(token text, lane text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
  q public.messages;
  history jsonb;
  views jsonb := '[]'::jsonb;
  related jsonb := '[]'::jsonb;
  pinned jsonb;
begin
  select * into j from public.jobs
    where member_id = c.member_id
      and (status = 'queued' or (status = 'running' and lease_until < now()))
      and attempts < 3
      and (kind not in ('work', 'plan', 'sandbox') or c.kind = 'claude')
      and case lane when 'heavy' then kind in ('work', 'answer', 'sandbox') when 'light' then kind not in ('work', 'answer', 'sandbox')
               else kind in ('answer', 'view', 'combine', 'intro', 'client') end
    order by (kind in ('client', 'listen')) desc, (kind = 'sandbox'), (kind in ('combine', 'work', 'review')) desc, created_at
    limit 1
    for update skip locked;
  if not found then
    return null;
  end if;
  update public.jobs
     set status = 'running', attempts = attempts + 1, lease_until = now() + (case when j.kind in ('work', 'sandbox') then interval '12 minutes' else interval '5 minutes' end),
         connection_id = c.id, started_at = now()
   where id = j.id;
  if j.kind = 'client' then
    return public.client_job_payload(j);
  end if;
  if j.kind = 'sandbox' then
    return public.sandbox_job_payload(j);
  end if;
  select * into q from public.messages where id = j.question_id;

  select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb) into history from (
    select m.created_at, m.body, m.by_ai, m.kind = 'client' as client, mem.display_name as name
      from public.messages m join public.members mem on mem.id = m.member_id
     where m.chat_id = j.chat_id and m.kind in ('chat', 'answer', 'client')
       and m.created_at < coalesce(q.created_at, now()) and m.id <> coalesce(j.question_id, m.id)
     order by m.created_at desc
     limit 400
  ) x;

  if j.kind in ('combine', 'work', 'review', 'plan') then
    select coalesce(jsonb_agg(jsonb_build_object('name', mem.display_name, 'view', m.body, 'meta', m.meta) order by m.created_at), '[]'::jsonb)
      into views
      from public.messages m join public.members mem on mem.id = m.member_id
     where m.table_id = j.table_id and m.kind = 'view' and m.meta ->> 'round' = j.round::text;
  end if;

  if q.body is not null then
    select coalesce(jsonb_agg(x), '[]'::jsonb) into related from (
      select ch.name as chat, mem.display_name as name, m.by_ai, m.kind = 'client' as client, m.body,
             ts_rank(m.search, public.loose_query(q.body)) as rank
        from public.messages m
        join public.members mem on mem.id = m.member_id
        join public.chats ch on ch.id = m.chat_id
       where m.table_id = j.table_id and m.kind in ('chat', 'answer', 'client') and m.id <> q.id
         and m.search @@ public.loose_query(q.body)
         and m.id not in (select m2.id from public.messages m2 where m2.chat_id = j.chat_id order by m2.created_at desc limit 21)
       order by rank desc
       limit 5
    ) x;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('kind', n.kind, 'title', n.title, 'body', n.body) order by n.kind desc, n.created_at), '[]'::jsonb)
    into pinned from public.notes n where n.table_id = j.table_id;

  return jsonb_build_object(
    'job_id', j.id,
    'kind', j.kind,
    'table_name', (select name from public.tables where id = j.table_id),
    'chat_name', (select name from public.chats where id = j.chat_id),
    'me', (select display_name from public.members where id = c.member_id),
    'asker', (select display_name from public.members where id = q.member_id),
    -- Whether the one asking is this connection's own person, and has left on that their AI may open places on
    -- their own computer that they point at. Never true for anyone else's message.
    'own_paths', coalesce(q.member_id = c.member_id and c.open_paths, false),
    -- Whether what they point at may also be handed to the other AIs working on the same request.
    'share_paths', coalesce(q.member_id = c.member_id and c.open_paths and c.share_paths, false),
    -- What another person's AI read from their own computer and shared for this request. Never this AI's own.
    'materials', (select coalesce(jsonb_agg(jsonb_build_object('from', mem.display_name, 'name', rm.name, 'body', rm.body) order by rm.created_at), '[]'::jsonb)
                    from public.round_materials rm join public.members mem on mem.id = rm.member_id
                   where rm.question_id = q.id and rm.member_id <> c.member_id),
    -- What was attached to the message being answered, and to the few before it in the same chat.
    'attachments', (select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb) from (
                      select a.id, a.name, a.mime, a.size, a.kind, a.path, l.url, a.created_at, mem.display_name as "from"
                        from public.attachments a join public.attachment_links l on l.attachment_id = a.id
                        join public.messages am on am.id = a.message_id join public.members mem on mem.id = a.member_id
                       where am.chat_id = j.chat_id and am.created_at <= q.created_at and am.created_at > q.created_at - interval '2 hours'
                       order by a.created_at desc limit 8) x),
    -- A message that starts with "/" runs one of the asker's own AI's commands. Its name and what it is for.
    'command', (select jsonb_build_object('name', cmd ->> 'name', 'about', cmd ->> 'about', 'mine', q.member_id = c.member_id)
                  from public.connections ac, jsonb_array_elements(ac.commands) cmd
                 where ac.member_id = q.member_id and ac.revoked_at is null
                   and q.body ~ '^\s*/' and lower(cmd ->> 'name') = lower(substring(q.body from '^\s*/([A-Za-z0-9:_-]+)'))
                 order by ac.last_seen desc nulls last limit 1),
    'question', q.body,
    'history', history,
    'views', views,
    'stage', j.stage,
    'brief', j.brief,
    'reference', (select tk.reference from public.tasks tk where tk.id = j.task_id),
    'task_title', (select tk.title from public.tasks tk where tk.id = j.task_id),
    'branch', (select tk.branch from public.tasks tk where tk.id = j.task_id),
    'team', (select coalesce(jsonb_agg(distinct mem.display_name), '[]'::jsonb)
               from public.connections cn join public.members mem on mem.id = cn.member_id and mem.role in ('owner', 'developer')
              where cn.table_id = j.table_id and cn.revoked_at is null and cn.kind = 'claude'
                and cn.last_seen > now() - interval '60 seconds' and cn.member_id <> c.member_id),
    -- Who is at the table, and what its clients have asked for that is still open: plain facts every AI here may
    -- need, the quick listener most of all.
    'people', (select coalesce(jsonb_agg(jsonb_build_object('name', mem.display_name, 'role', mem.role,
                 'ai', (select cn.kind from public.connections cn where cn.member_id = mem.id and cn.revoked_at is null
                          and cn.last_seen > now() - interval '60 seconds' order by cn.last_seen desc limit 1)) order by mem.created_at), '[]'::jsonb)
                 from public.members mem where mem.table_id = j.table_id and mem.removed_at is null),
    'requests', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
                   select mem.display_name as "from", left(r.title, 160) as title, r.status, r.created_at
                     from public.requests r join public.members mem on mem.id = r.member_id
                    where r.table_id = j.table_id and r.status not in ('done', 'decided')
                    order by r.created_at desc limit 15) x),
    'tasks', (select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb) from (
                select tk.id, tk.title, tk.status, tk.created_at, mem.display_name as asked_by,
                       (select ch.name from public.chats ch where ch.id = tk.chat_id) as chat
                  from public.tasks tk left join public.members mem on mem.id = tk.member_id
                 where tk.table_id = j.table_id and (tk.status = 'working' or tk.created_at > now() - interval '3 days')
                 order by tk.created_at desc limit 8) x),
    'worker', (select mem.display_name from public.jobs w join public.members mem on mem.id = w.member_id where w.round = j.round and w.kind = 'work' limit 1),
    'work_read', (select m.meta ->> 'read' from public.jobs w join public.messages m on m.id = w.result_message_id
                   where w.round = j.round and w.kind = 'work' and w.status = 'done' and coalesce((w.outcome ->> 'changed')::boolean, false)
                   order by w.stage desc limit 1),
    'related', related,
    'pinned', pinned);
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
$function$;

CREATE OR REPLACE FUNCTION public.listen_now()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  l public.listens;
  who uuid;
  strong boolean;
  weak boolean;
  after_ai boolean;
  latest uuid;
  seat uuid;
  n integer := 0;
begin
  update public.jobs set status = 'skipped', lease_until = null, error = 'nobody picked it up'
   where kind in ('listen', 'look')
     and ((status = 'queued' and created_at < now() - interval '45 seconds')
       or (status = 'running' and lease_until < now() - interval '1 minute'));
  for l in select * from public.listens where due_at <= now() for update skip locked loop
    if exists (select 1 from public.jobs j where j.chat_id = l.chat_id and j.status in ('queued', 'running', 'waiting')
                 and j.kind in ('listen', 'look')) then
      continue;
    end if;
    delete from public.listens where chat_id = l.chat_id;
    seat := public.final_seat_now(l.table_id);
    continue when seat is null;
    -- Was the last thing said before these messages said by an AI, a little while ago?
    after_ai := coalesce((select p.by_ai from public.messages p
                           where p.chat_id = l.chat_id and p.kind in ('chat', 'answer') and p.created_at < l.since
                             and p.created_at > l.since - interval '15 minutes'
                           order by p.created_at desc limit 1), false);
    -- Each person who wrote is heard on their own: two people asking for two things at the same moment are two
    -- requests, and each goes to its own person's AI.
    for who in select distinct m.member_id from public.messages m
                where m.chat_id = l.chat_id and m.kind = 'chat' and not m.by_ai and m.created_at >= l.since loop
      select coalesce(bool_or(char_length(m.body) >= 40
                 or m.body ~ '^\s*/[A-Za-z]' or m.body ~* '\?|@|\m(ai|ais|claude|chatgpt|gpt|codex|table|longtable)\M'
                 or m.body ~* '^\s*(can|could|would|will|please|pls|make|add|fix|change|update|remove|delete|build|write|check|look|why|how|what|where|when|which|who|should|is|are|does|do|did|implement|create|refactor|rename|move|review|explain|tell|show|find|lets|let''s|try|use|set|put|run|test|ship|revert|undo)\M'), false),
             coalesce(bool_or(m.body ~* '^\s*(yes|yeah|yep|no|nah|ok|okay|sure|go)\M'), false)
        into strong, weak
        from public.messages m
       where m.chat_id = l.chat_id and m.kind = 'chat' and not m.by_ai and m.created_at >= l.since and m.member_id = who;
      -- Anything said straight after an AI spoke is heard, whatever its shape: it is most likely an answer to it.
      continue when not (strong or after_ai);
      select m.id into latest from public.messages m
       where m.chat_id = l.chat_id and m.kind = 'chat' and not m.by_ai and m.created_at >= l.since and m.member_id = who
       order by m.created_at desc limit 1;
      -- A message that was asked outright already has the AIs on it.
      continue when latest is null or exists (select 1 from public.jobs j where j.question_id = latest and j.kind not in ('listen', 'look'));
      insert into public.jobs (table_id, chat_id, member_id, question_id, kind) values (l.table_id, l.chat_id, seat, latest, 'listen');
      n := n + 1;
    end loop;
  end loop;
  return n;
end;
$function$;

revoke all on function public.ask_table(uuid, text, jsonb) from public, anon;
grant execute on function public.ask_table(uuid, text, jsonb) to authenticated;
revoke all on function public.client_say(uuid, text, jsonb) from public, anon;
grant execute on function public.client_say(uuid, text, jsonb) to authenticated;

-- A plain message with things attached. Without attachments a message is still written straight to the table.
create function public.send_with_files(c uuid, body text, files jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  t uuid;
  me uuid;
  q uuid;
  words text := btrim(coalesce(body, ''));
  got jsonb;
begin
  select ch.table_id into t from public.chats ch where ch.id = c;
  if t is null or not public.is_team(t) then
    raise exception 'only the team writes here';
  end if;
  if coalesce(jsonb_array_length(files), 0) = 0 then
    raise exception 'nothing is attached';
  end if;
  me := public.my_member_id(t);
  if char_length(words) = 0 then
    words := left((select string_agg(f ->> 'name', ', ') from jsonb_array_elements(files) f), 500);
  end if;
  insert into public.messages (table_id, chat_id, member_id, body) values (t, c, me, left(words, 8000)) returning id into q;
  got := public.take_files(t, me, files, q);
  update public.messages set meta = meta || jsonb_build_object('files', got) where id = q;
  return q;
end;
$$;
revoke all on function public.send_with_files(uuid, text, jsonb) from public, anon;
grant execute on function public.send_with_files(uuid, text, jsonb) to authenticated;

-- A message is told to the room when it is written; what is attached lands a moment later, so it is told again.
create trigger messages_files_broadcast after update of meta on public.messages
  for each row when (new.meta ? 'files' and not (old.meta ? 'files')) execute function public.broadcast_message();

-- The team sees each connection's switches and the names of its commands (never a token).
grant select (open_paths, share_paths, commands) on public.connections to authenticated;
grant select (files) on public.requests to authenticated;
