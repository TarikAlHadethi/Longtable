-- Pages (18 Oct 2026, his words: artifacts are "very very veryyy important", with everything they do).
--
-- A Claude at the table can make a page: a whole HTML document (a report, a mockup, a chart, a dashboard, a small
-- tool) that opens inside Longtable in a locked frame. The team sees it in the chat it was asked in, as with any
-- answer; a client never does. Each change is a version that can be looked at and gone back to. People comment on
-- it, on the whole page or on words picked out of it, reply, resolve, and can send a comment to the AIs, which then
-- change the page. A page that is a tool can keep shared state the whole team sees (`page_state`), and each person
-- can pin pages. Everything changes through the functions below; no one writes the tables directly.

create table public.pages (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables(id) on delete cascade,
  chat_id uuid not null,
  job_id uuid references public.jobs(id) on delete set null,
  made_by uuid references public.members(id) on delete set null,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  about text not null default '' check (char_length(about) <= 300),
  icon text not null default 'page' check (icon ~ '^[a-z]{1,24}$'),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  touched_at timestamptz not null default now(),
  foreign key (chat_id, table_id) references public.chats(id, table_id) on delete cascade
);
create index pages_table on public.pages (table_id, touched_at desc);
create index pages_job on public.pages (job_id);

create table public.page_versions (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.pages(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  n integer not null,
  html text not null check (char_length(html) between 1 and 2000000),
  job_id uuid references public.jobs(id) on delete set null,
  made_by uuid references public.members(id) on delete set null,
  by_ai boolean not null default true,
  note text not null default '' check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  unique (page_id, n)
);

create table public.page_comments (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.pages(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  member_id uuid references public.members(id) on delete set null,
  parent_id uuid references public.page_comments(id) on delete cascade,
  version integer not null,
  anchor text not null default '' check (char_length(anchor) <= 300),
  body text not null check (char_length(body) <= 4000),
  to_ai boolean not null default false,
  resolved_at timestamptz,
  resolved_by uuid references public.members(id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index page_comments_page on public.page_comments (page_id, created_at);

create table public.page_state (
  page_id uuid not null references public.pages(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  key text not null check (key ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  value jsonb not null check (pg_column_size(value) <= 65536),
  updated_by uuid references public.members(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (page_id, key)
);

create table public.page_pins (
  member_id uuid not null references public.members(id) on delete cascade,
  page_id uuid not null references public.pages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (member_id, page_id)
);

alter table public.pages enable row level security;
alter table public.page_versions enable row level security;
alter table public.page_comments enable row level security;
alter table public.page_state enable row level security;
alter table public.page_pins enable row level security;
revoke all on public.pages, public.page_versions, public.page_comments, public.page_state, public.page_pins from anon, authenticated;
grant select on public.pages, public.page_versions, public.page_comments, public.page_state, public.page_pins to authenticated;
-- The team of the table, and nobody else: no client, nobody removed, no other table.
create policy "the team sees its pages" on public.pages for select using (public.is_team(table_id));
create policy "the team sees its page versions" on public.page_versions for select using (public.is_team(table_id));
create policy "the team sees its page comments" on public.page_comments for select using (public.is_team(table_id));
create policy "the team sees its pages' state" on public.page_state for select using (public.is_team(table_id));
create policy "each person sees their own pins" on public.page_pins for select
  using (exists (select 1 from public.members m join public.pages p on p.id = page_pins.page_id
                  where m.id = page_pins.member_id and m.user_id = auth.uid() and m.removed_at is null and public.is_team(p.table_id)));

-- Live: pages, comments and state go to the team's channel. A version goes out without its HTML, which the page
-- reads when it opens.
create trigger pages_broadcast after insert or update on public.pages
  for each row execute function public.broadcast_team_change();
create trigger page_comments_broadcast after insert or update on public.page_comments
  for each row execute function public.broadcast_team_change();
create trigger page_state_broadcast after insert or update on public.page_state
  for each row execute function public.broadcast_team_change();

create function public.broadcast_page_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(jsonb_build_object('table', 'page_versions', 'record', jsonb_build_object('id', new.id, 'page_id', new.page_id,
    'table_id', new.table_id, 'n', new.n, 'made_by', new.made_by, 'by_ai', new.by_ai, 'note', new.note, 'created_at', new.created_at)),
    'INSERT', 'team:' || new.table_id::text, true);
  return null;
end;
$$;
revoke all on function public.broadcast_page_version() from public, anon, authenticated;
create trigger page_versions_broadcast after insert on public.page_versions
  for each row execute function public.broadcast_page_version();

create function public.broadcast_page_gone()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(jsonb_build_object('table', 'pages', 'record', jsonb_build_object('id', old.id, 'table_id', old.table_id, 'deleted', true)),
    'UPDATE', 'team:' || old.table_id::text, true);
  return null;
end;
$$;
revoke all on function public.broadcast_page_gone() from public, anon, authenticated;
create trigger pages_gone after delete on public.pages
  for each row execute function public.broadcast_page_gone();

-- The page a person may act on: theirs to act on only while they are on its table's team.
create function public.team_page(p uuid)
returns public.pages language plpgsql stable security definer set search_path = '' as $$
declare
  pg public.pages;
begin
  select * into pg from public.pages where id = p;
  if not found or not public.is_team(pg.table_id) then
    raise exception 'that page is not at a table you are on';
  end if;
  return pg;
end;
$$;
revoke all on function public.team_page(uuid) from public, anon, authenticated;

-- A Claude at the table makes a page, or a new version of one, while it is doing a job of its own.
create function public.runner_page(token text, job uuid, page jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
  pg public.pages;
  html text := coalesce(page ->> 'html', '');
  made integer;
  target uuid;
  mark text := lower(coalesce(nullif(page ->> 'icon', ''), 'page'));
begin
  select * into j from public.jobs where id = job and connection_id = c.id and member_id = c.member_id and status = 'running' for update;
  if not found or j.kind not in ('look', 'answer', 'work', 'combine') or j.chat_id is null then
    raise exception 'this job cannot make a page';
  end if;
  if char_length(html) = 0 or char_length(html) > 2000000 then
    raise exception 'a page is between 1 character and 2,000,000';
  end if;
  select count(*) into made from public.page_versions where job_id = j.id;
  if made >= 3 then
    raise exception 'one job makes at most three pages or versions';
  end if;
  html := public.hide_secrets(html);
  if mark !~ '^[a-z]{1,24}$' then mark := 'page'; end if;
  if nullif(page ->> 'update', '') is not null then
    begin
      target := (page ->> 'update')::uuid;
    exception when others then
      raise exception 'that is not a page here';
    end;
    select * into pg from public.pages where id = target and table_id = j.table_id for update;
    if not found then
      raise exception 'that is not a page here';
    end if;
    update public.pages
       set version = version + 1, touched_at = now(),
           title = coalesce(nullif(left(btrim(public.hide_secrets(coalesce(page ->> 'title', ''))), 120), ''), title),
           about = coalesce(nullif(left(public.hide_secrets(coalesce(page ->> 'about', '')), 300), ''), about),
           icon = case when page ? 'icon' then mark else pages.icon end
     where id = pg.id returning * into pg;
  else
    insert into public.pages (table_id, chat_id, job_id, made_by, title, about, icon)
      values (j.table_id, j.chat_id, j.id, j.member_id,
              coalesce(nullif(left(btrim(public.hide_secrets(coalesce(page ->> 'title', ''))), 120), ''), 'A page'),
              left(public.hide_secrets(coalesce(page ->> 'about', '')), 300), mark)
      returning * into pg;
  end if;
  insert into public.page_versions (page_id, table_id, n, html, job_id, made_by, by_ai, note)
    values (pg.id, pg.table_id, pg.version, html, j.id, j.member_id, true, left(public.hide_secrets(coalesce(page ->> 'note', '')), 200));
  return pg.id;
end;
$$;
revoke all on function public.runner_page(text, uuid, jsonb) from public;
grant execute on function public.runner_page(text, uuid, jsonb) to anon, authenticated;

-- What a team job is handed of the pages in its chat: the three touched most lately, each with its newest HTML, so
-- an AI asked about a page (or sent a comment on one) can change it.
create function public.pages_for_job(j public.jobs)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x.touched_at desc), '[]'::jsonb) from (
    select p.id, p.title, p.about, p.version, p.touched_at,
           (select left(v.html, 300000) from public.page_versions v where v.page_id = p.id and v.n = p.version) as html,
           (select coalesce(jsonb_agg(jsonb_build_object('from', mem.display_name, 'on', cm.anchor, 'said', cm.body) order by cm.created_at), '[]'::jsonb)
              from public.page_comments cm left join public.members mem on mem.id = cm.member_id
             where cm.page_id = p.id and cm.resolved_at is null and cm.deleted_at is null) as comments
      from public.pages p
     where p.chat_id = j.chat_id and p.table_id = j.table_id
     order by p.touched_at desc
     limit 3) x;
$$;
revoke all on function public.pages_for_job(public.jobs) from public, anon, authenticated;

-- A comment on a page: on the whole of it, or on words picked out of it; a reply in a thread; or sent to the AIs,
-- which asks the table to change the page.
create function public.comment_page(p uuid, body text, anchor text default '', parent uuid default null, to_ai boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  pg public.pages := public.team_page(p);
  me uuid := public.my_member_id(pg.table_id);
  words text := btrim(coalesce(body, ''));
  picked text := left(btrim(coalesce(anchor, '')), 300);
  made uuid;
begin
  if char_length(words) = 0 or char_length(words) > 4000 then
    raise exception 'a comment is between 1 and 4,000 characters';
  end if;
  if parent is not null and not exists (select 1 from public.page_comments where page_comments.id = parent and page_id = pg.id) then
    raise exception 'that reply is not to a comment on this page';
  end if;
  if (select count(*) from public.page_comments where member_id = me and created_at > now() - interval '1 hour') >= 120 then
    raise exception 'that is a lot of comments for one hour; try again a little later';
  end if;
  insert into public.page_comments (page_id, table_id, member_id, parent_id, version, anchor, body, to_ai)
    values (pg.id, pg.table_id, me, parent, pg.version, picked, words, to_ai)
    returning page_comments.id into made;
  update public.pages set touched_at = now() where pages.id = pg.id;
  if to_ai then
    perform public.ask_table(pg.chat_id, left(format('On the page "%s"%s: %s', pg.title,
      case when picked <> '' then format(', where it says "%s"', picked) else '' end, words), 8000), '[]'::jsonb);
  end if;
  return made;
end;
$$;

create function public.resolve_page_comment(cm uuid, done boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
declare
  x public.page_comments;
begin
  select * into x from public.page_comments where id = cm;
  if not found or not public.is_team(x.table_id) then
    raise exception 'that comment is not at a table you are on';
  end if;
  update public.page_comments
     set resolved_at = case when done then now() end, resolved_by = case when done then public.my_member_id(x.table_id) end
   where id = cm;
end;
$$;

create function public.delete_page_comment(cm uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  x public.page_comments;
begin
  select * into x from public.page_comments where id = cm;
  if not found or not public.is_team(x.table_id) then
    raise exception 'that comment is not at a table you are on';
  end if;
  if x.member_id is distinct from public.my_member_id(x.table_id) and not public.is_owner(x.table_id) then
    raise exception 'only whoever wrote a comment, or the owner, takes it away';
  end if;
  update public.page_comments set deleted_at = now(), body = '', anchor = '' where id = cm;
end;
$$;

-- Going back to an earlier version makes it the newest one again; nothing is lost.
create function public.restore_page_version(p uuid, n integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  pg public.pages := public.team_page(p);
  old public.page_versions;
begin
  select * into old from public.page_versions where page_id = pg.id and page_versions.n = restore_page_version.n;
  if not found then
    raise exception 'that page has no such version';
  end if;
  update public.pages set version = version + 1, touched_at = now() where id = pg.id returning * into pg;
  insert into public.page_versions (page_id, table_id, n, html, made_by, by_ai, note)
    values (pg.id, pg.table_id, pg.version, old.html, public.my_member_id(pg.table_id), false, format('Back to version %s', old.n));
  return pg.version;
end;
$$;

create function public.rename_page(p uuid, title text, about text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  pg public.pages := public.team_page(p);
begin
  if char_length(btrim(coalesce(title, ''))) not between 1 and 120 then
    raise exception 'a page''s name is between 1 and 120 characters';
  end if;
  update public.pages set title = btrim(rename_page.title), about = coalesce(left(rename_page.about, 300), pages.about), touched_at = now()
   where id = pg.id;
end;
$$;

-- Whoever's AI made it, or the owner, deletes a page with all its versions and comments.
create function public.delete_page(p uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  pg public.pages := public.team_page(p);
begin
  if pg.made_by is distinct from public.my_member_id(pg.table_id) and not public.is_owner(pg.table_id) then
    raise exception 'only the person whose AI made a page, or the owner, deletes it';
  end if;
  delete from public.pages where id = pg.id;
end;
$$;

create function public.pin_page(p uuid, pinned boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
declare
  pg public.pages := public.team_page(p);
  me uuid := public.my_member_id(pg.table_id);
begin
  if pinned then
    insert into public.page_pins (member_id, page_id) values (me, pg.id) on conflict do nothing;
  else
    delete from public.page_pins where member_id = me and page_id = pg.id;
  end if;
end;
$$;

-- What a page that is a tool keeps for everyone who opens it: a few hundred small values, each at most 64 KB.
create function public.set_page_state(p uuid, key text, value jsonb)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  pg public.pages := public.team_page(p);
  at timestamptz := now();
begin
  if key !~ '^[A-Za-z0-9_.:-]{1,100}$' then
    raise exception 'a key is letters, numbers and . _ : - only, up to 100';
  end if;
  if pg_column_size(value) > 65536 then
    raise exception 'one value is at most 64 KB';
  end if;
  if value is null or value = 'null'::jsonb then
    delete from public.page_state where page_id = pg.id and page_state.key = set_page_state.key;
    return at;
  end if;
  if not exists (select 1 from public.page_state where page_id = pg.id and page_state.key = set_page_state.key)
     and (select count(*) from public.page_state where page_id = pg.id) >= 300 then
    raise exception 'a page keeps at most 300 values';
  end if;
  insert into public.page_state (page_id, table_id, key, value, updated_by, updated_at)
    values (pg.id, pg.table_id, key, value, public.my_member_id(pg.table_id), at)
    on conflict on constraint page_state_pkey do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return at;
end;
$$;

revoke all on function public.comment_page(uuid, text, text, uuid, boolean), public.resolve_page_comment(uuid, boolean),
  public.delete_page_comment(uuid), public.restore_page_version(uuid, integer), public.rename_page(uuid, text, text),
  public.delete_page(uuid), public.pin_page(uuid, boolean), public.set_page_state(uuid, text, jsonb) from public, anon;
grant execute on function public.comment_page(uuid, text, text, uuid, boolean), public.resolve_page_comment(uuid, boolean),
  public.delete_page_comment(uuid), public.restore_page_version(uuid, integer), public.rename_page(uuid, text, text),
  public.delete_page(uuid), public.pin_page(uuid, boolean), public.set_page_state(uuid, text, jsonb) to authenticated;

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
     set status = 'running', attempts = attempts + 1, lease_until = now() + (case when j.kind in ('work', 'sandbox') then interval '12 minutes' when j.kind = 'listen' then interval '90 seconds' when j.kind = 'look' then interval '2 minutes' else interval '5 minutes' end),
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
    -- A message that starts with "/" runs one of the asker's own AI's commands. Its name, and what it is for only to
    -- the asker's own AI (or for a command every Claude has built in): someone's own commands stay theirs.
    'command', (select jsonb_build_object('name', cmd ->> 'name', 'mine', q.member_id = c.member_id)
                       || case when q.member_id = c.member_id or cmd ->> 'kind' = 'builtin'
                               then jsonb_build_object('about', cmd ->> 'about') else '{}'::jsonb end
                  from public.connections ac, jsonb_array_elements(ac.commands) cmd
                 where ac.member_id = q.member_id and ac.revoked_at is null
                   and q.body ~ '^\s*/' and lower(cmd ->> 'name') = lower(substring(q.body from '^\s*/([A-Za-z0-9:_-]+)'))
                 order by ac.last_seen desc nulls last limit 1),
    -- The pages in this chat, with their newest HTML, so a page can be changed when asked.
    'pages', public.pages_for_job(j),
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
$function$
;

-- The owner's Download everything carries the pages too.
CREATE OR REPLACE FUNCTION public.export_table(t uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_owner(t) then
    raise exception 'only the owner downloads the whole table';
  end if;
  return jsonb_build_object(
    'exported_at', now(),
    'table', (select to_jsonb(x) - 'created_by' from public.tables x where x.id = t),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.display_name, 'role', m.role,
                 'joined', m.created_at, 'removed', m.removed_at) order by m.created_at), '[]') from public.members m where m.table_id = t),
    'chats', (select coalesce(jsonb_agg(to_jsonb(c) - 'search' order by c.created_at), '[]') from public.chats c where c.table_id = t),
    'messages', (select coalesce(jsonb_agg(to_jsonb(m) - 'search' order by m.created_at), '[]') from public.messages m where m.table_id = t),
    'decisions', (select coalesce(jsonb_agg(to_jsonb(d) || jsonb_build_object('options',
                    (select coalesce(jsonb_agg(to_jsonb(o) order by o.position), '[]') from public.decision_options o where o.decision_id = d.id))
                  order by d.created_at), '[]') from public.decisions d where d.table_id = t),
    'requests', (select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('timeline',
                   (select coalesce(jsonb_agg(e.label order by e.id), '[]') from public.request_events e where e.request_id = r.id))
                 order by r.created_at), '[]') from public.requests r where r.table_id = t),
    'told_clients', (select coalesce(jsonb_agg(to_jsonb(u) order by u.created_at), '[]') from public.client_updates u where u.table_id = t),
    'notes', (select coalesce(jsonb_agg(to_jsonb(n) order by n.created_at), '[]') from public.notes n where n.table_id = t),
    -- Pages: each with every version and every comment.
    'pages', (select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object(
                'versions', (select coalesce(jsonb_agg(jsonb_build_object('n', v.n, 'html', v.html, 'note', v.note, 'by_ai', v.by_ai, 'made_by', v.made_by, 'at', v.created_at) order by v.n), '[]') from public.page_versions v where v.page_id = p.id),
                'comments', (select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at), '[]') from public.page_comments c where c.page_id = p.id and c.deleted_at is null))
              order by p.created_at), '[]') from public.pages p where p.table_id = t),
    'activity', (select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at), '[]') from public.activity a where a.table_id = t));
end;
$function$
;
