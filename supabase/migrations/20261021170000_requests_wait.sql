-- Asking permission like Claude Code at home, for people who know no commands:
-- 1. Auto by default: Claude Code's own safety check lets through what is safe, so almost nothing needs the person.
-- 2. What still needs them waits for their answer, as at home, instead of becoming a no after ten minutes. It ends
--    only when the person answers or the job itself ends (stopped, finished, or its computer gone).
-- 3. Each request says in one plain line why it is wanted (what Claude Code wrote for it), so it can be answered
--    without reading the command.

alter table public.connections alter column mode set default 'auto';
-- Everyone still on the old default moves to Auto. Manual and Plan, which someone picked, stay as they are.
update public.connections set mode = 'auto' where mode = 'acceptEdits';

alter table public.approvals add column why text;
grant select (why) on public.approvals to authenticated;

drop function public.runner_ask_approval(text, text, text);
create function public.runner_ask_approval(key text, tool text, summary text, why text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs := public.job_for_key(key);
  cn public.connections;
  a uuid;
begin
  select * into cn from public.connections where member_id = j.member_id and table_id = j.table_id and revoked_at is null and kind = 'claude'
   order by last_seen desc nulls last limit 1;
  if (select count(*) from public.approvals where job_id = j.id and status = 'waiting') >= 5
     or (select count(*) from public.approvals where connection_id = cn.id and status = 'waiting') >= 20
     or (select count(*) from public.approvals where connection_id = cn.id and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'too many requests are waiting for an answer';
  end if;
  insert into public.approvals (table_id, connection_id, member_id, job_id, tool, summary, why)
    values (j.table_id, cn.id, j.member_id, j.id, public.kept_line(tool, 80), left(public.hide_secrets(left(coalesce(summary, ''), 4000)), 2000),
      -- Keys hidden before cutting: a key cut in half would no longer look like one.
      nullif(left(public.hide_secrets(regexp_replace(left(coalesce(why, ''), 2000), '\s+', ' ', 'g')), 200), ''))
    returning id into a;
  perform realtime.send(jsonb_build_object('table', 'approvals', 'record', jsonb_build_object('id', a, 'member_id', j.member_id)),
    'INSERT', 'team:' || j.table_id::text, true);
  return a;
end;
$$;
revoke all on function public.runner_ask_approval(text, text, text, text) from public, authenticated;
grant execute on function public.runner_ask_approval(text, text, text, text) to anon;

-- The answer is read for as long as the job runs: no clock turns a request into a no.
create or replace function public.runner_approval(key text, a uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs := public.job_for_key(key);
  r public.approvals;
begin
  select * into r from public.approvals where id = a and job_id = j.id;
  if not found then
    raise exception 'no such request';
  end if;
  return jsonb_build_object('status', r.status, 'always', r.always);
end;
$$;

-- The person answers whenever they come back, while the job still waits for it.
create or replace function public.decide_approval(a uuid, allow boolean, always_allow boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.approvals;
begin
  select * into r from public.approvals where id = a for update;
  if not found or r.member_id <> public.my_member_id(r.table_id) then
    raise exception 'only the person whose AI asked can answer';
  end if;
  if r.status <> 'waiting' then
    raise exception 'this request was already answered, or its work has ended';
  end if;
  update public.approvals set status = case when allow then 'allowed' else 'denied' end,
    always = allow and coalesce(always_allow, false), decided_at = now() where id = a;
  perform realtime.send(jsonb_build_object('table', 'approvals', 'record', jsonb_build_object('id', a, 'member_id', r.member_id)),
    'UPDATE', 'team:' || r.table_id::text, true);
end;
$$;

-- A job taken up again (its connection restarted mid-wait) gets a new key, and what its earlier run asked ends: that
-- run is gone, so nothing would ever read an answer to it, and the new run asks again.
create or replace function public.runner_job_key(token text, job uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
  k text := encode(extensions.gen_random_bytes(24), 'hex');
  t uuid;
  m uuid;
begin
  if not c.full_claude then
    raise exception 'this AI is not set to run as full Claude Code';
  end if;
  update public.jobs set approval_key = encode(extensions.digest(k, 'sha256'), 'hex')
   where id = job and member_id = c.member_id and table_id = c.table_id and status = 'running'
   returning table_id, member_id into t, m;
  if not found then
    raise exception 'that job is not running on this connection';
  end if;
  if exists (select 1 from public.approvals where job_id = job and status = 'waiting') then
    update public.approvals set status = 'expired', decided_at = now() where job_id = job and status = 'waiting';
    perform realtime.send(jsonb_build_object('table', 'approvals', 'record', jsonb_build_object('member_id', m)), 'UPDATE', 'team:' || t::text, true);
  end if;
  return k;
end;
$$;

-- Turned off, their full Claude Code asks nothing more, and what it was waiting on ends with it.
create or replace function public.set_full_claude(conn uuid, full_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  cn public.connections;
begin
  select * into cn from public.connections where id = conn and revoked_at is null for update;
  if not found or cn.member_id <> public.my_member_id(cn.table_id) then
    raise exception 'this is yours to set only for your own AI';
  end if;
  if cn.kind <> 'claude' then
    raise exception 'only a Claude can run as full Claude Code';
  end if;
  update public.connections set full_claude = coalesce(full_on, false) where id = conn;
  if not coalesce(full_on, false) and exists (select 1 from public.approvals where connection_id = conn and status = 'waiting') then
    update public.approvals set status = 'expired', decided_at = now() where connection_id = conn and status = 'waiting';
    perform realtime.send(jsonb_build_object('table', 'approvals', 'record', jsonb_build_object('member_id', cn.member_id)), 'UPDATE', 'team:' || cn.table_id::text, true);
  end if;
end;
$$;
