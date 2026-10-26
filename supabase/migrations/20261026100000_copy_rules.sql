-- What a client's copy may change, per table. "screens" (every table's default) keeps the strict guard: only what
-- people see and click. "code" also lets a copy change the code behind the screens (server components, actions, API
-- routes), for a table whose preview is fully separate: its own made-up database, no real keys, no email. Either way
-- the connection still refuses env files and keys, build, deploy and package files, migrations and the database,
-- scripts, middleware, sign-in and permission code, tests, and code that reaches for env values, programs, files or
-- outside sites; and every change is type-checked before it is pushed. `blocked` is the owner's own list of paths a
-- copy may never change, whatever the mode (a file, or a folder ending in "/").

alter table public.table_sandbox add column if not exists scope text not null default 'screens' check (scope in ('screens', 'code')),
  add column if not exists blocked text not null default '';

create or replace function public.set_copy_rules(t uuid, scope text, blocked text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare
  clean text;
begin
  if not public.may(t, 'clients') then
    raise exception 'only the owner sets this';
  end if;
  if scope not in ('screens', 'code') then
    raise exception 'a copy changes screens only, or screens and the code behind them';
  end if;
  select coalesce(string_agg(f, ', '), '') into clean from (
    select btrim(x) as f from regexp_split_to_table(coalesce(blocked, ''), '[,\n]') x) y where f <> '';
  if clean ~ '[^A-Za-z0-9._/, *-]' or clean ~ '(^|[/ ])\.\.([/, ]|$)' then
    raise exception 'blocked paths are plain paths like prisma/ or proxy.ts, separated by commas';
  end if;
  insert into public.table_sandbox (table_id, scope, blocked) values (t, scope, left(clean, 2000))
    on conflict (table_id) do update set scope = excluded.scope, blocked = excluded.blocked;
  perform public.log_activity(t, public.my_member_id(t), 'sandbox.rules', null, jsonb_build_object('scope', scope));
end;
$$;
revoke all on function public.set_copy_rules(uuid, text, text) from public, anon;
grant execute on function public.set_copy_rules(uuid, text, text) to authenticated;

CREATE OR REPLACE FUNCTION public.sandbox_job_payload(j jobs)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ch public.sandbox_changes;
  who public.members;
begin
  if j.change_id is null then
    -- Only the place is being made: the branch, pushed as it stands, so the hosting puts it up.
    return jsonb_build_object('job_id', j.id, 'kind', 'sandbox', 'probe', true, 'fresh', coalesce(j.brief = 'fresh', false),
      'refresh', coalesce(j.brief = 'refresh', false),
      'table_name', (select name from public.tables where id = j.table_id),
      'me', (select display_name from public.members where id = j.member_id),
      'branch', (select s.branch from public.sandboxes s where s.member_id = j.subject));
  end if;
  select * into ch from public.sandbox_changes where id = j.change_id;
  select * into who from public.members where id = ch.member_id;
  if j.brief = 'undo' then
    -- Taking one change back out: its commit, and the words it was for (for the commit's message). Marked a probe
    -- too, so a connection from before undo existed only looks at the branch and changes nothing.
    return jsonb_build_object('job_id', j.id, 'kind', 'sandbox', 'undo', true, 'probe', true, 'commit', ch.commit, 'words', ch.words,
      'me', (select display_name from public.members where id = j.member_id),
      'branch', (select s.branch from public.sandboxes s where s.member_id = ch.member_id));
  end if;
  return jsonb_build_object(
    'job_id', j.id,
    'kind', 'sandbox',
    'table_name', (select name from public.tables where id = j.table_id),
    'me', (select display_name from public.members where id = j.member_id),
    'client', who.display_name,
    'words', ch.words,
    'test', ch.test,
    'branch', (select s.branch from public.sandboxes s where s.member_id = ch.member_id),
    'paths', coalesce((select ts.paths from public.table_sandbox ts where ts.table_id = j.table_id), ''),
    'scope', coalesce((select ts.scope from public.table_sandbox ts where ts.table_id = j.table_id), 'screens'),
    'blocked', coalesce((select ts.blocked from public.table_sandbox ts where ts.table_id = j.table_id), ''),
    'earlier', (select coalesce(jsonb_agg(jsonb_build_object('words', left(c.words, 600), 'summary', left(coalesce(c.summary, ''), 400), 'status', c.status,
                  'verdict', c.verdict, 'note', c.note) order by c.created_at), '[]'::jsonb)
                  from (select * from public.sandbox_changes x where x.member_id = ch.member_id and x.id <> ch.id and x.status <> 'working'
                         order by x.created_at desc limit 12) c));
end;
$function$

;

-- Connect 0.1.43: the copy rules.
update public.connect_release set version = '0.1.43', set_at = now();
