-- A person's own Claude can ask them a question with choices, as Claude Code does at home: it shows as a card with a
-- button for each choice (and room to answer in their own words), only to them, and their Claude carries on with the
-- answer. It rides on the same requests as permission prompts (the job's own key, the same limits, ended with its job),
-- marked as a question.

alter table public.approvals add column kind text not null default 'approve' check (kind in ('approve', 'question'));
alter table public.approvals add column options jsonb;
alter table public.approvals add column answer text;

create function public.runner_ask_question(key text, question text, options jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs := public.job_for_key(key);
  cn public.connections;
  a uuid;
  opts jsonb;
begin
  -- Two to six choices, each a short label and an optional line about it, keys hidden.
  select coalesce(jsonb_agg(jsonb_build_object(
           'label', left(public.hide_secrets(left(coalesce(o ->> 'label', ''), 400)), 120),
           'about', nullif(left(public.hide_secrets(left(coalesce(o ->> 'about', ''), 1000)), 300), ''))), '[]'::jsonb)
    into opts
    from (select o from jsonb_array_elements(case when jsonb_typeof(options) = 'array' then options else '[]'::jsonb end) o
           where jsonb_typeof(o) = 'object' and btrim(coalesce(o ->> 'label', '')) <> '' limit 6) picked;
  if jsonb_array_length(opts) < 2 then
    raise exception 'a question needs at least two choices';
  end if;
  select * into cn from public.connections where member_id = j.member_id and table_id = j.table_id and revoked_at is null and kind = 'claude'
   order by last_seen desc nulls last limit 1;
  if (select count(*) from public.approvals where job_id = j.id and status = 'waiting') >= 5
     or (select count(*) from public.approvals where connection_id = cn.id and status = 'waiting') >= 20
     or (select count(*) from public.approvals where connection_id = cn.id and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'too many requests are waiting for an answer';
  end if;
  insert into public.approvals (table_id, connection_id, member_id, job_id, tool, summary, kind, options)
    values (j.table_id, cn.id, j.member_id, j.id, 'question', left(public.hide_secrets(left(coalesce(question, ''), 4000)), 2000), 'question', opts)
    returning id into a;
  perform realtime.send(jsonb_build_object('table', 'approvals', 'record', jsonb_build_object('id', a, 'member_id', j.member_id)),
    'INSERT', 'team:' || j.table_id::text, true);
  return a;
end;
$$;
revoke all on function public.runner_ask_question(text, text, jsonb) from public, authenticated;
grant execute on function public.runner_ask_question(text, text, jsonb) to anon;

-- The person's answer to their own Claude's question: one of the choices or their own words.
create function public.answer_question(a uuid, words text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.approvals;
  clean text := btrim(coalesce(words, ''));
begin
  select * into r from public.approvals where id = a for update;
  if not found or r.member_id <> public.my_member_id(r.table_id) then
    raise exception 'only the person whose AI asked can answer';
  end if;
  if r.kind <> 'question' then
    raise exception 'that is a request to allow, not a question';
  end if;
  if r.status <> 'waiting' then
    raise exception 'this question was already answered, or its work has ended';
  end if;
  if clean = '' then
    raise exception 'an answer cannot be empty';
  end if;
  update public.approvals set status = 'allowed', answer = left(clean, 2000), decided_at = now() where id = a;
  perform realtime.send(jsonb_build_object('table', 'approvals', 'record', jsonb_build_object('id', a, 'member_id', r.member_id)),
    'UPDATE', 'team:' || r.table_id::text, true);
end;
$$;
revoke all on function public.answer_question(uuid, text) from public, anon;
grant execute on function public.answer_question(uuid, text) to authenticated;

-- A question is answered with words, never allowed or denied.
create or replace function public.decide_approval(a uuid, allow boolean, always_allow boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.approvals;
begin
  select * into r from public.approvals where id = a for update;
  if not found or r.member_id <> public.my_member_id(r.table_id) then
    raise exception 'only the person whose AI asked can answer';
  end if;
  if r.kind = 'question' then
    raise exception 'that is a question; answer it with words';
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

-- The answer goes back with the status, for a question.
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
  return jsonb_build_object('status', r.status, 'always', r.always, 'answer', r.answer);
end;
$$;
