-- Design decisions of 16 Oct 2026 (group 4), the database half. Each was chosen from a short list.
--
-- Files go with what they belong to: the owner may remove any file of their table from storage, and anyone their own
-- (the screens do it just before a table, or the test client, is deleted). Storage itself refuses deletes from SQL.
-- 200 MB of attachments per person per table, said plainly when reached. Ten connect codes an hour per person.
-- The two ticks before a copy is given ("made-up data", "no real keys") are kept with who ticked and when, and a copy
-- cannot be given without them. A GitHub delivery seen once is ignored the second time (a replay). A message's time
-- is the database's, not whatever a person's page sent. A repository address with a sign-in in it is refused. And an
-- account that made a table or an invite can be deleted: the table and the invite stay, without the link to it.

-- ---- Files
drop policy if exists "remove your own, or the owner removes the table's" on storage.objects;
create policy "remove your own, or the owner removes the table's" on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
         and (public.is_owner(((storage.foldername(name))[1])::uuid)
              or public.my_member_id(((storage.foldername(name))[1])::uuid)::text = (storage.foldername(name))[2]));

-- ---- A message's time is the database's own
create or replace function public.message_time_is_now()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- A person writing through the app gets the server's clock; the database's own functions keep theirs.
  if current_user in ('authenticated', 'anon') then
    new.created_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.message_time_is_now() from public, anon, authenticated;
drop trigger if exists message_time_is_now on public.messages;
create trigger message_time_is_now before insert on public.messages for each row execute function public.message_time_is_now();

-- ---- An account can be deleted
alter table public.tables alter column created_by drop not null;
alter table public.invites alter column created_by drop not null;
alter table public.tables drop constraint tables_created_by_fkey,
  add constraint tables_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null;
alter table public.invites drop constraint invites_created_by_fkey,
  add constraint invites_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null;
alter table public.invites drop constraint invites_used_by_fkey,
  add constraint invites_used_by_fkey foreign key (used_by) references auth.users (id) on delete set null;

-- ---- The two ticks are kept
alter table public.sandboxes add column if not exists ticked_by uuid references public.members (id) on delete set null;
alter table public.sandboxes add column if not exists ticked_at timestamptz;

-- ---- The server's clock, so a page can count down against it rather than against its own computer's clock
create or replace function public.server_now()
returns timestamptz language sql stable set search_path = '' as $$ select now(); $$;
revoke all on function public.server_now() from public, anon;
grant execute on function public.server_now() to authenticated;

-- ---- GitHub deliveries, remembered for a day
create table if not exists public.github_deliveries (
  table_id uuid not null references public.tables (id) on delete cascade,
  delivery text not null,
  at timestamptz not null default now(),
  primary key (table_id, delivery)
);
alter table public.github_deliveries enable row level security;
revoke all on public.github_deliveries from anon, authenticated;

CREATE OR REPLACE FUNCTION public.take_files(t uuid, owner uuid, files jsonb, msg uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me uuid := public.my_member_id(t);
  f jsonb;
  o record;
  made uuid;
  mime text;
  out jsonb := '[]'::jsonb;
  n integer := 0;
  used bigint;
begin
  if me is null then
    raise exception 'you are not at this table';
  end if;
  -- What this person already keeps at this table, from their own folder.
  select coalesce(sum(a.size), 0) into used from public.attachments a where a.table_id = t and a.path like t::text || '/' || me::text || '/%';
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
    used := used + coalesce((o.metadata ->> 'size')::bigint, 0);
    if used > 200 * 1024 * 1024 then
      raise exception 'that would be more than 200 MB of attachments from you at this table, which is the most each person keeps';
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
$function$
;

CREATE OR REPLACE FUNCTION public.start_pairing(t uuid, ai_kind text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if (select count(*) from public.pairings p where p.member_id = me and p.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'that is ten connect codes this hour; try again in a while';
  end if;
  raw := upper(encode(extensions.gen_random_bytes(10), 'hex'));
  insert into public.pairings (table_id, member_id, kind, code_hash)
    values (t, me, ai_kind, encode(extensions.digest(raw, 'sha256'), 'hex'));
  return raw;
end;
$function$
;

drop function if exists public.set_client_sandbox(uuid, boolean);

CREATE OR REPLACE FUNCTION public.set_client_sandbox(m uuid, enabled boolean, made_up_data boolean DEFAULT false, no_real_keys boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  who public.members;
  seat uuid;
begin
  select * into who from public.members where id = m and removed_at is null;
  if not found or not public.is_owner(who.table_id) then
    raise exception 'only the owner decides what a client can do';
  end if;
  if who.role <> 'client' then
    raise exception 'a sandbox is for a client';
  end if;
  if enabled and not exists (select 1 from public.sandboxes s where s.member_id = m and s.url is not null) then
    raise exception 'set the copy up first: it needs an address to open at';
  end if;
  -- Only the owner can answer these two, and a copy is not given until they have.
  if enabled and not (coalesce(made_up_data, false) and coalesce(no_real_keys, false)) then
    raise exception 'a copy is given only once you have said its previews run on made-up data and hold no real keys';
  end if;
  insert into public.sandboxes (member_id, table_id, mode, branch)
    values (m, who.table_id, case when enabled then 'sandbox' else 'chat' end, 'longtable/sandbox-'
      || coalesce(nullif(btrim(left(regexp_replace(lower(who.display_name), '[^a-z0-9]+', '-', 'g'), 30), '-'), ''), 'client')
      || '-' || left(m::text, 8))
    on conflict (member_id) do update set mode = excluded.mode;
  if enabled then
    update public.sandboxes set ticked_by = public.my_member_id(who.table_id), ticked_at = now() where member_id = m;
  end if;
  insert into public.table_sandbox (table_id) values (who.table_id) on conflict (table_id) do nothing;
  -- What the owner tried in the copy while setting it up is not the client's: the copy goes back to the product as
  -- it stands before it is theirs. The connection does it, with no AI asked anything.
  if enabled and exists (select 1 from public.sandbox_changes c where c.member_id = m and c.test and c.status = 'ready')
     and not exists (select 1 from public.sandbox_changes c where c.member_id = m and not c.test) then
    select cn.member_id into seat
      from public.connections cn join public.members mm on mm.id = cn.member_id and mm.role in ('owner', 'developer')
     where cn.table_id = who.table_id and cn.revoked_at is null and cn.kind = 'claude'
     order by (cn.last_seen > now() - interval '60 seconds') desc, (cn.member_id = public.final_seat_now(who.table_id)) desc, cn.created_at limit 1;
    if seat is not null then
      insert into public.jobs (table_id, member_id, kind, subject, brief) values (who.table_id, seat, 'sandbox', m, 'fresh');
    end if;
  end if;
  -- The client's page hears that what it can do has changed.
  perform realtime.send(jsonb_build_object('table', 'sandbox_changes', 'record', jsonb_build_object('id', m, 'status', 'mode')),
    'UPDATE', 'client:' || who.table_id::text || ':' || m::text, true);
  perform public.log_activity(who.table_id, public.my_member_id(who.table_id), case when enabled then 'sandbox.given' else 'sandbox.taken' end, m,
    jsonb_build_object('name', who.display_name));
end;
$function$
;

revoke all on function public.set_client_sandbox(uuid, boolean, boolean, boolean) from public, anon;
grant execute on function public.set_client_sandbox(uuid, boolean, boolean, boolean) to authenticated;

drop function if exists public.github_event(uuid, text, text, text);

CREATE OR REPLACE FUNCTION public.github_event(t uuid, signature text, event text, payload text, delivery text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  h public.github_hooks;
  p jsonb;
  line text;
  general uuid;
  owner_id uuid;
  ref text;
  n int;
begin
  select * into h from public.github_hooks where table_id = t;
  if not found or signature is null
     or signature <> 'sha256=' || encode(extensions.hmac(convert_to(coalesce(payload, ''), 'utf8'), convert_to(h.secret, 'utf8'), 'sha256'), 'hex') then
    return 'refused';
  end if;
  begin
    p := payload::jsonb;
  exception when others then
    return 'refused';
  end;
  -- The same delivery a second time is a replay: it is ignored. Deliveries are remembered for a day.
  if coalesce(delivery, '') <> '' then
    delete from public.github_deliveries where at < now() - interval '1 day';
    insert into public.github_deliveries (table_id, delivery) values (t, left(delivery, 100)) on conflict do nothing;
    if not found then
      return 'ignored';
    end if;
  end if;
  update public.github_hooks set last_event_at = now(), repo = coalesce(p #>> '{repository,full_name}', repo) where table_id = t;

  if event = 'ping' then
    line := 'GitHub is connected' || coalesce(' to ' || (p #>> '{repository,full_name}'), '') || '.';
  elsif event = 'push' then
    ref := regexp_replace(coalesce(p ->> 'ref', ''), '^refs/heads/', '');
    if ref <> coalesce(p #>> '{repository,default_branch}', 'main') then
      return 'ignored';
    end if;
    n := jsonb_array_length(coalesce(p -> 'commits', '[]'::jsonb));
    if n = 0 then
      return 'ignored';
    end if;
    line := coalesce(p #>> '{pusher,name}', 'Someone') || ' pushed ' || n || case when n = 1 then ' commit' else ' commits' end
      || ' to ' || ref || ': ' || left(split_part(coalesce(p #>> '{head_commit,message}', ''), E'\n', 1), 140);
  elsif event = 'pull_request' then
    if p ->> 'action' = 'opened' then
      line := coalesce(p #>> '{pull_request,user,login}', 'Someone') || ' opened pull request #' || (p #>> '{pull_request,number}')
        || ': ' || left(coalesce(p #>> '{pull_request,title}', ''), 140);
    elsif p ->> 'action' = 'closed' and (p #>> '{pull_request,merged}')::boolean then
      line := 'Pull request #' || (p #>> '{pull_request,number}') || ' was merged: ' || left(coalesce(p #>> '{pull_request,title}', ''), 140);
    else
      return 'ignored';
    end if;
  elsif event = 'deployment_status' then
    if p #>> '{deployment_status,state}' = 'success'
       and coalesce(p #>> '{deployment_status,environment_url}', p #>> '{deployment_status,target_url}', '') ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' then
      update public.sandboxes s
         set url = left(coalesce(p #>> '{deployment_status,environment_url}', p #>> '{deployment_status,target_url}'), 300)
       where s.table_id = t
         and (s.branch = p #>> '{deployment,ref}' or s.tip = p #>> '{deployment,sha}'
              or exists (select 1 from public.sandbox_changes c where c.member_id = s.member_id and c.commit = p #>> '{deployment,sha}'));
      return case when found then 'noted' else 'ignored' end;
    end if;
    return 'ignored';
  elsif event = 'workflow_run' then
    if p ->> 'action' <> 'completed' or p #>> '{workflow_run,conclusion}' <> 'failure' then
      return 'ignored';
    end if;
    line := 'CI failed on ' || coalesce(p #>> '{workflow_run,head_branch}', 'a branch') || ': '
      || left(coalesce(p #>> '{workflow_run,name}', 'a workflow'), 80);
  else
    return 'ignored';
  end if;

  select c.id into general from public.chats c where c.table_id = t and c.is_general;
  select m.id into owner_id from public.members m where m.table_id = t and m.role = 'owner';
  insert into public.messages (table_id, chat_id, member_id, body, kind, meta)
    values (t, general, owner_id, public.hide_secrets(line), 'github', jsonb_build_object('event', event));
  return 'posted';
end;
$function$
;

revoke all on function public.github_event(uuid, text, text, text, text) from public;
grant execute on function public.github_event(uuid, text, text, text, text) to anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_table_repo(t uuid, url text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  clean text := btrim(coalesce(url, ''));
begin
  if not public.is_team(t) then
    raise exception 'only the team can say where the code is';
  end if;
  if clean = '' then
    delete from public.table_code where table_id = t;
  else
    if clean !~ '^(https://|ssh://|git@)[A-Za-z0-9@:/._~+-]{4,250}$' then
      raise exception 'that does not look like a repository address; it starts with https:// or git@';
    end if;
    -- A sign-in written into the address (https://name:token@...) would be kept and shown to the team: refused.
    if clean ~ '^(https|ssh)://[^/]*@' then
      raise exception 'that address has a sign-in in it; give it without the name or token before the @';
    end if;
    insert into public.table_code (table_id, repo_url) values (t, clean)
      on conflict (table_id) do update set repo_url = excluded.repo_url, updated_at = now();
  end if;
  perform public.log_activity(t, public.my_member_id(t), 'table.repo_set', t, jsonb_build_object('set', clean <> ''));
end;
$function$
;
