-- Step 3: each person's own AI joins through a connection on their computer, and works a queue of jobs.
-- The connection never holds a Supabase login. It holds a long random device token, of which only a hash is kept,
-- and it can only call the four runner functions below.

-- AI messages: written by a person's AI, never by a person pretending to be one.
alter table public.messages add column by_ai boolean not null default false;
alter table public.messages add column meta jsonb not null default '{}'::jsonb;
drop policy "the team writes messages as itself" on public.messages;
create policy "the team writes messages as itself" on public.messages
  for insert to authenticated
  with check (public.is_team(table_id) and member_id = public.my_member_id(table_id) and not by_ai and meta = '{}'::jsonb);

-- Connections: one live connection per person per kind of AI.
create table public.connections (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  kind text not null check (kind in ('claude', 'codex')),
  token_hash text not null unique,
  label text not null default '' check (char_length(label) <= 80),
  created_at timestamptz not null default now(),
  last_seen timestamptz,
  revoked_at timestamptz
);
create unique index connections_one_live on public.connections (member_id, kind) where revoked_at is null;

-- Pairing codes: one use, 15 minutes, only a hash kept.
create table public.pairings (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  kind text not null check (kind in ('claude', 'codex')),
  code_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  used_at timestamptz
);

-- Jobs: work for one person's AI. Claimed with a lease, so a connection that dies hands the job back.
create type public.job_status as enum ('queued', 'running', 'done', 'failed');

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables (id) on delete cascade,
  chat_id uuid not null,
  member_id uuid not null references public.members (id) on delete cascade,
  question_id uuid references public.messages (id) on delete set null,
  status public.job_status not null default 'queued',
  attempts integer not null default 0,
  lease_until timestamptz,
  connection_id uuid references public.connections (id) on delete set null,
  result_message_id uuid references public.messages (id) on delete set null,
  error text,
  usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  foreign key (chat_id, table_id) references public.chats (id, table_id) on delete cascade
);
create index jobs_waiting_idx on public.jobs (member_id, created_at) where status in ('queued', 'running');

alter table public.connections enable row level security;
alter table public.pairings enable row level security;
alter table public.jobs enable row level security;
revoke all on public.connections, public.pairings, public.jobs from anon;

-- People see their own table's connections (never the hash) and jobs. Pairings are never readable.
create policy "the team sees who is connected" on public.connections
  for select to authenticated using (public.is_team(table_id));
create policy "the team sees the jobs" on public.jobs
  for select to authenticated using (public.is_team(table_id));
-- Column privileges only work once the table-wide grant is gone: a column REVOKE under a table-wide SELECT does nothing.
revoke all on public.connections from authenticated;
grant select (id, table_id, member_id, kind, label, created_at, last_seen, revoked_at) on public.connections to authenticated;

-- Start pairing: a one-time code for this person's own AI. Shown once, in the Connect link.
create function public.start_pairing(t uuid, ai_kind text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  raw text;
  me uuid := public.my_member_id(t);
begin
  if me is null then
    raise exception 'only people at this table can connect an AI';
  end if;
  if ai_kind not in ('claude', 'codex') then
    raise exception 'unknown kind of AI';
  end if;
  if ai_kind = 'claude' and not public.is_team(t) then
    raise exception 'only the team connects Claude Code';
  end if;
  raw := upper(encode(extensions.gen_random_bytes(10), 'hex'));
  insert into public.pairings (table_id, member_id, kind, code_hash)
    values (t, me, ai_kind, encode(extensions.digest(raw, 'sha256'), 'hex'));
  return raw;
end;
$$;

-- The connection redeems the code for its device token. Called by the connection itself, without a login.
create function public.pair_connection(code text, device_label text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.pairings;
  token text;
  conn uuid;
  who public.members;
  tname text;
begin
  select * into p from public.pairings
    where code_hash = encode(extensions.digest(upper(btrim(code)), 'sha256'), 'hex')
    for update;
  if not found or p.used_at is not null or p.expires_at < now() then
    raise exception 'this connect code is not valid any more; press Connect again';
  end if;
  update public.pairings set used_at = now() where id = p.id;
  update public.connections set revoked_at = now()
    where member_id = p.member_id and kind = p.kind and revoked_at is null;
  token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.connections (table_id, member_id, kind, token_hash, label, last_seen)
    values (p.table_id, p.member_id, p.kind, encode(extensions.digest(token, 'sha256'), 'hex'), left(btrim(coalesce(device_label, '')), 80), now())
    returning id into conn;
  select * into who from public.members where id = p.member_id;
  select name into tname from public.tables where id = p.table_id;
  perform public.log_activity(p.table_id, p.member_id, 'connection.paired', conn, jsonb_build_object('kind', p.kind, 'name', who.display_name));
  return jsonb_build_object('token', token, 'table_id', p.table_id, 'table_name', tname,
    'member_id', p.member_id, 'member_name', who.display_name, 'kind', p.kind);
end;
$$;

-- Which live connection a device token belongs to.
create function public.connection_for(token text)
returns public.connections language plpgsql security definer set search_path = '' as $$
declare
  c public.connections;
begin
  select * into c from public.connections
    where token_hash = encode(extensions.digest(token, 'sha256'), 'hex') and revoked_at is null;
  if not found then
    raise exception 'this connection was removed; connect again from Longtable';
  end if;
  update public.connections set last_seen = now() where id = c.id;
  return c;
end;
$$;

-- The runner says hello: who it works for.
create function public.runner_hello(token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
begin
  return jsonb_build_object(
    'table_id', c.table_id,
    'table_name', (select name from public.tables where id = c.table_id),
    'member_id', c.member_id,
    'member_name', (select display_name from public.members where id = c.member_id),
    'kind', c.kind);
end;
$$;

-- The runner takes the next job for its person, with a five-minute lease. Returns null when there is none.
create function public.runner_claim(token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
  q public.messages;
  history jsonb;
begin
  select * into j from public.jobs
    where member_id = c.member_id
      and (status = 'queued' or (status = 'running' and lease_until < now()))
      and attempts < 3
    order by created_at
    limit 1
    for update skip locked;
  if not found then
    return null;
  end if;
  update public.jobs
     set status = 'running', attempts = attempts + 1, lease_until = now() + interval '5 minutes',
         connection_id = c.id, started_at = now()
   where id = j.id;
  select * into q from public.messages where id = j.question_id;
  select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb) into history from (
    select m.created_at, m.body, m.by_ai, mem.display_name as name, mem.role
      from public.messages m join public.members mem on mem.id = m.member_id
     where m.chat_id = j.chat_id and m.created_at < coalesce(q.created_at, now()) and m.id <> coalesce(j.question_id, m.id)
     order by m.created_at desc
     limit 20
  ) x;
  return jsonb_build_object(
    'job_id', j.id,
    'table_name', (select name from public.tables where id = j.table_id),
    'chat_name', (select name from public.chats where id = j.chat_id),
    'me', (select display_name from public.members where id = c.member_id),
    'asker', (select display_name from public.members where id = q.member_id),
    'question', q.body,
    'history', history);
end;
$$;

-- Secrets never reach the room: anything shaped like a key is replaced before an answer is posted.
create function public.hide_secrets(t text)
returns text language sql immutable set search_path = '' as $$
  select regexp_replace(t,
    '(sk-ant-[A-Za-z0-9_-]{8,}|sb_secret_[A-Za-z0-9_-]{8,}|sb_publishable_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)',
    '[hidden]', 'g');
$$;

-- The runner posts its answer. It lands as that person's AI, in the chat the question came from.
create function public.runner_finish(token text, job uuid, answer text, info jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
  msg uuid;
  clean text := public.hide_secrets(left(coalesce(answer, ''), 8000));
begin
  select * into j from public.jobs where id = job for update;
  if not found or j.member_id <> c.member_id or j.status <> 'running' then
    raise exception 'this job is not yours to finish';
  end if;
  if btrim(clean) = '' then
    raise exception 'an answer cannot be empty';
  end if;
  insert into public.messages (table_id, chat_id, member_id, body, by_ai, meta)
    values (j.table_id, j.chat_id, j.member_id, clean, true,
            jsonb_build_object('job', j.id, 'read', info ->> 'read', 'model', info ->> 'model',
                               'hidden', clean <> left(coalesce(answer, ''), 8000)))
    returning id into msg;
  update public.jobs
     set status = 'done', result_message_id = msg, finished_at = now(), lease_until = null,
         usage = coalesce(info -> 'usage', '{}'::jsonb)
   where id = j.id;
  perform public.log_activity(j.table_id, j.member_id, 'ai.answered', msg, jsonb_build_object('job', j.id));
  return msg;
end;
$$;

-- The runner gives up on a job: back in the queue unless it has failed three times.
create function public.runner_fail(token text, job uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
begin
  select * into j from public.jobs where id = job for update;
  if not found or j.member_id <> c.member_id or j.status <> 'running' then
    raise exception 'this job is not yours';
  end if;
  update public.jobs
     set status = case when j.attempts >= 3 then 'failed'::public.job_status else 'queued'::public.job_status end,
         error = left(coalesce(reason, ''), 500), lease_until = null
   where id = j.id;
end;
$$;

-- Ask the table: the question goes in the chat, and a job goes to one AI.
-- Who answers, for now: the owner's AI if connected, then the asker's own, then any connected developer's.
create function public.ask_table(c uuid, body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t uuid;
  me uuid;
  q uuid;
  seat uuid;
  job uuid;
begin
  select ch.table_id into t from public.chats ch where ch.id = c;
  if t is null or not public.is_team(t) then
    raise exception 'only the team can ask the table';
  end if;
  if char_length(btrim(coalesce(body, ''))) = 0 then
    raise exception 'ask something';
  end if;
  me := public.my_member_id(t);
  insert into public.messages (table_id, chat_id, member_id, body) values (t, c, me, btrim(body)) returning id into q;
  select cn.member_id into seat
    from public.connections cn join public.members m on m.id = cn.member_id
   where cn.table_id = t and cn.revoked_at is null and cn.kind = 'claude'
   order by (m.role = 'owner') desc, (cn.member_id = me) desc, cn.created_at
   limit 1;
  if seat is not null then
    insert into public.jobs (table_id, chat_id, member_id, question_id) values (t, c, seat, q) returning id into job;
    perform public.log_activity(t, me, 'table.asked', q, jsonb_build_object('job', job));
  end if;
  return jsonb_build_object('message_id', q, 'job_id', job, 'answered_by', seat);
end;
$$;

-- Disconnect: the person removes their own connection, or the owner removes anyone's.
create function public.disconnect(conn uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  cn public.connections;
begin
  select * into cn from public.connections where id = conn for update;
  if not found or not (cn.member_id = public.my_member_id(cn.table_id) or public.is_owner(cn.table_id)) then
    raise exception 'not yours to disconnect';
  end if;
  update public.connections set revoked_at = now() where id = conn and revoked_at is null;
  perform public.log_activity(cn.table_id, public.my_member_id(cn.table_id), 'connection.removed', conn, jsonb_build_object('kind', cn.kind));
end;
$$;

revoke all on function public.start_pairing(uuid, text), public.pair_connection(text, text), public.connection_for(text),
  public.runner_hello(text), public.runner_claim(text), public.runner_finish(text, uuid, text, jsonb),
  public.runner_fail(text, uuid, text), public.ask_table(uuid, text), public.disconnect(uuid), public.hide_secrets(text)
  from public;
grant execute on function public.start_pairing(uuid, text), public.ask_table(uuid, text), public.disconnect(uuid) to authenticated;
-- The connection has no login: it calls these with the publishable key and proves itself with its device token.
grant execute on function public.pair_connection(text, text), public.runner_hello(text), public.runner_claim(text),
  public.runner_finish(text, uuid, text, jsonb), public.runner_fail(text, uuid, text) to anon, authenticated;

-- Live: the team sees jobs start and finish, and connections come and go.
create trigger jobs_broadcast after insert or update on public.jobs
  for each row execute function public.broadcast_team_change();
-- Connections go out without their token hash.
create function public.broadcast_connection_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object('table', 'connections', 'record', to_jsonb(new) - 'token_hash'),
    tg_op, 'team:' || new.table_id::text, true);
  return null;
end;
$$;
create trigger connections_broadcast after insert or update on public.connections
  for each row execute function public.broadcast_connection_change();
