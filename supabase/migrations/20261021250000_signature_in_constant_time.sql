-- GitHub's webhook signature is checked in constant time (it was a plain comparison, noted in THREAT-MODEL.md).
CREATE OR REPLACE FUNCTION public.github_event(t uuid, signature text, event text, payload text, delivery text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  cmp_key bytea := extensions.gen_random_bytes(32);
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
     -- Compared in constant time: both sides are hashed again under a key made fresh for this one comparison, so how
     -- long it takes says nothing about how much of a forged signature was right.
     or extensions.hmac(convert_to(signature, 'utf8'), cmp_key, 'sha256')
        <> extensions.hmac(convert_to('sha256=' || encode(extensions.hmac(convert_to(coalesce(payload, ''), 'utf8'), convert_to(h.secret, 'utf8'), 'sha256'), 'hex'), 'utf8'), cmp_key, 'sha256') then
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
