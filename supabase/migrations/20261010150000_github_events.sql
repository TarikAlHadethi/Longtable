-- Step 6: GitHub events in the chat. The owner connects a repo with a webhook (a URL and a secret from Settings);
-- GitHub signs every delivery with the secret, the database checks the signature, and a short line lands in General:
-- pushes to the default branch, pull requests opened and merged, and CI runs that failed. Longtable never stores code,
-- only these lines. The secret is shown once and readable only by the function that checks signatures.

create table public.github_hooks (
  table_id uuid primary key references public.tables (id) on delete cascade,
  secret text not null,
  repo text not null default '',
  created_at timestamptz not null default now(),
  last_event_at timestamptz
);
alter table public.github_hooks enable row level security;
revoke all on public.github_hooks from public, anon, authenticated;

alter table public.messages drop constraint messages_kind_check;
alter table public.messages add constraint messages_kind_check check (kind in ('chat', 'answer', 'view', 'intro', 'client', 'github'));

-- Connect (or reconnect, which replaces the secret): owner only. Returns the secret, once.
create function public.connect_github(t uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  raw text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not public.is_owner(t) then
    raise exception 'only the owner connects GitHub';
  end if;
  insert into public.github_hooks (table_id, secret) values (t, raw)
    on conflict (table_id) do update set secret = excluded.secret, repo = '', last_event_at = null;
  perform public.log_activity(t, public.my_member_id(t), 'github.connected', t, '{}'::jsonb);
  return raw;
end;
$$;
revoke all on function public.connect_github(uuid) from public, anon;
grant execute on function public.connect_github(uuid) to authenticated;

create function public.disconnect_github(t uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_owner(t) then
    raise exception 'only the owner disconnects GitHub';
  end if;
  delete from public.github_hooks where table_id = t;
  perform public.log_activity(t, public.my_member_id(t), 'github.disconnected', t, '{}'::jsonb);
end;
$$;
revoke all on function public.disconnect_github(uuid) from public, anon;
grant execute on function public.disconnect_github(uuid) to authenticated;

-- Whether a table is connected, for the team's Settings page, without the secret.
create function public.github_status(t uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when public.is_team(t) then
    (select jsonb_build_object('connected', true, 'repo', h.repo, 'last_event_at', h.last_event_at)
       from public.github_hooks h where h.table_id = t)
  end;
$$;
revoke all on function public.github_status(uuid) from public, anon;
grant execute on function public.github_status(uuid) to authenticated;

-- A delivery from GitHub. Called by the web app's webhook route with the raw body as GitHub sent it. Returns
-- 'posted', 'ignored' or 'refused'; a bad signature changes nothing.
create function public.github_event(t uuid, signature text, event text, payload text)
returns text language plpgsql security definer set search_path = '' as $$
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
$$;
revoke all on function public.github_event(uuid, text, text, text) from public;
grant execute on function public.github_event(uuid, text, text, text) to anon, authenticated;
