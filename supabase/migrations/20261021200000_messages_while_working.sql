-- Talking to your own Claude while it works, as at home: what you type in the chat while it works on your request is
-- passed into that same run at its next step (the connection hands it to Claude Code through a hook), instead of
-- waiting to become a new request. Only the person's own plain messages, only to their own request's run. While it
-- takes them, the listener leaves that person's messages to it, and comes back to anything the run did not read.

alter table public.jobs add column taking boolean not null default false;
-- A message handed to a run; confirmed once the run has read it. One handed over but not confirmed counts as handed
-- over only while that run is running: a run that ended or failed without reading it gives it back to the listener.
create table public.delivered_messages (
  message_id uuid primary key references public.messages(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  confirmed boolean not null default false,
  at timestamptz not null default now()
);
alter table public.delivered_messages enable row level security;
revoke all on public.delivered_messages from public, anon, authenticated;

-- Whether a message is now a running or finished run's to answer, so the listener leaves it alone.
create function public.message_taken(m uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.delivered_messages d join public.jobs dj on dj.id = d.job_id
                  where d.message_id = m and (d.confirmed or (dj.status = 'running' and dj.lease_until > now())));
$$;
revoke all on function public.message_taken(uuid) from public, anon, authenticated;

-- open: the run takes messages now; returns the asker's new ones (each handed over once). Closed: it takes no more,
-- what it read is confirmed, and what it was handed but never read goes back to be heard as usual.
create function public.runner_inbox(token text, job uuid, open boolean default true, seen uuid[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
  q public.messages;
  got jsonb;
  back timestamptz;
begin
  select * into j from public.jobs where id = job and member_id = c.member_id for update;
  if not found then
    raise exception 'that job is not this connection''s';
  end if;
  if not coalesce(open, true) then
    update public.jobs set taking = false where id = job;
    update public.delivered_messages set confirmed = true where job_id = job and message_id = any(coalesce(seen, '{}'::uuid[]));
    select min(m.created_at) into back from public.messages m
      join public.delivered_messages d on d.message_id = m.id and d.job_id = job and not d.confirmed;
    delete from public.delivered_messages where job_id = job and not confirmed;
    if back is not null then
      insert into public.listens (chat_id, table_id, since, due_at) values (j.chat_id, j.table_id, back, now() + interval '4 seconds')
        on conflict (chat_id) do update set since = least(public.listens.since, excluded.since), due_at = least(public.listens.due_at, excluded.due_at);
    end if;
    return '[]'::jsonb;
  end if;
  select * into q from public.messages where id = j.question_id;
  -- Only a run of the person's own request, while it runs.
  if j.status <> 'running' or q.id is null or q.member_id <> c.member_id then
    return '[]'::jsonb;
  end if;
  if not j.taking then
    -- A new attempt at this job (its connection restarted): what an earlier attempt was handed but never read is
    -- handed over again.
    delete from public.delivered_messages where job_id = job and not confirmed;
    update public.jobs set taking = true where id = job;
  end if;
  with fresh as (
    select m.id, m.body, m.created_at from public.messages m
     where m.chat_id = j.chat_id and m.member_id = c.member_id and m.kind = 'chat' and not m.by_ai
       and m.created_at > q.created_at and m.id <> q.id
       -- Not one that is a request of its own (asked outright, or already heard), not a command, not one with files:
       -- those go to the table as usual.
       and not exists (select 1 from public.jobs jj where jj.question_id = m.id)
       and m.body !~ '^\s*/[A-Za-z]'
       and not exists (select 1 from public.attachments a where a.message_id = m.id)
       and not exists (select 1 from public.delivered_messages d where d.message_id = m.id)
     order by m.created_at limit 20
  ), kept as (
    insert into public.delivered_messages (message_id, job_id) select id, job from fresh on conflict do nothing returning message_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'body', f.body, 'at', f.created_at) order by f.created_at), '[]'::jsonb)
    into got from fresh f where f.id in (select message_id from kept);
  return got;
end;
$$;
revoke all on function public.runner_inbox(text, uuid, boolean, uuid[]) from public, authenticated;
grant execute on function public.runner_inbox(text, uuid, boolean, uuid[]) to anon;

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
  skipped timestamptz;
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
    skipped := null;
    after_ai := coalesce((select p.by_ai from public.messages p
                           where p.chat_id = l.chat_id and p.kind in ('chat', 'answer') and p.created_at < l.since
                             and p.created_at > l.since - interval '15 minutes'
                           order by p.created_at desc limit 1), false);
    -- Each person who wrote is heard on their own: two people asking for two things at the same moment are two
    -- requests, and each goes to its own person's AI.
    for who in select distinct m.member_id from public.messages m
                where m.chat_id = l.chat_id and m.kind = 'chat' and not m.by_ai and m.created_at >= l.since and not public.message_taken(m.id) loop
      -- Their own AI is at work on their request in this chat and taking what they say into it, as at home: it gets
      -- these messages itself. They are heard again once that work ends, so nothing it did not get is lost.
      if exists (select 1 from public.jobs tj join public.messages tq on tq.id = tj.question_id
                  where tj.chat_id = l.chat_id and tj.taking and tj.status = 'running' and tj.lease_until > now() and tq.member_id = who) then
        skipped := least(coalesce(skipped, 'infinity'::timestamptz), (select min(m2.created_at) from public.messages m2
                    where m2.chat_id = l.chat_id and m2.member_id = who and m2.kind = 'chat' and not m2.by_ai and m2.created_at >= l.since));
        continue;
      end if;
      select coalesce(bool_or(char_length(m.body) >= 40
                 or m.body ~ '^\s*/[A-Za-z]' or m.body ~* '\?|@|\m(ai|ais|claude|chatgpt|gpt|codex|table|longtable)\M'
                 or m.body ~* '^\s*(can|could|would|will|please|pls|make|add|fix|change|update|remove|delete|build|write|check|look|why|how|what|where|when|which|who|should|is|are|does|do|did|implement|create|refactor|rename|move|review|explain|tell|show|find|lets|let''s|try|use|set|put|run|test|ship|revert|undo)\M'), false),
             coalesce(bool_or(m.body ~* '^\s*(yes|yeah|yep|no|nah|ok|okay|sure|go)\M'), false)
        into strong, weak
        from public.messages m
       where m.chat_id = l.chat_id and m.kind = 'chat' and not m.by_ai and m.created_at >= l.since and not public.message_taken(m.id) and m.member_id = who;
      -- Anything said straight after an AI spoke is heard, whatever its shape: it is most likely an answer to it.
      continue when not (strong or after_ai);
      select m.id into latest from public.messages m
       where m.chat_id = l.chat_id and m.kind = 'chat' and not m.by_ai and m.created_at >= l.since and not public.message_taken(m.id) and m.member_id = who
       order by m.created_at desc limit 1;
      -- A message that was asked outright already has the AIs on it.
      -- A message that was asked outright already has the AIs on it, and one already heard is not heard again (the chat's
      -- window can reach back over it while someone's own run takes their words).
      continue when latest is null or exists (select 1 from public.jobs j where j.question_id = latest);
      insert into public.jobs (table_id, chat_id, member_id, question_id, kind) values (l.table_id, l.chat_id, seat, latest, 'listen');
      n := n + 1;
    end loop;
    if skipped is not null then
      insert into public.listens (chat_id, table_id, since, due_at) values (l.chat_id, l.table_id, skipped, now() + interval '5 seconds')
        on conflict (chat_id) do update set since = least(public.listens.since, excluded.since), due_at = least(public.listens.due_at, excluded.due_at);
    end if;
  end loop;
  return n;
end;
$function$;
