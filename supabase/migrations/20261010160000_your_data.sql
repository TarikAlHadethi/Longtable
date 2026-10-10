-- Step 7: your data. The owner can download a table's whole record and delete the table for good; anyone can
-- download what is theirs. Secrets never leave: no token hashes, no webhook secret, and a client's private chat with
-- their own AI goes only to that client.

-- Everything a table holds, for its owner.
create function public.export_table(t uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
    'activity', (select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at), '[]') from public.activity a where a.table_id = t));
end;
$$;
revoke all on function public.export_table(uuid) from public, anon;
grant execute on function public.export_table(uuid) to authenticated;

-- What is yours at a table: your messages, your requests and what you were told, your chat with your own AI.
create function public.export_mine(t uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me public.members;
begin
  select * into me from public.members where table_id = t and user_id = auth.uid() and removed_at is null;
  if not found then
    raise exception 'you are not at this table';
  end if;
  return jsonb_build_object(
    'exported_at', now(),
    'table', (select name from public.tables where id = t),
    'you', jsonb_build_object('name', me.display_name, 'role', me.role, 'joined', me.created_at),
    'your_messages', (select coalesce(jsonb_agg(jsonb_build_object('at', m.created_at, 'body', m.body, 'kind', m.kind) order by m.created_at), '[]')
                       from public.messages m where m.member_id = me.id and not m.by_ai),
    'your_requests', (select coalesce(jsonb_agg(jsonb_build_object('at', r.created_at, 'title', r.title, 'body', r.body, 'status', r.status,
                        'timeline', (select coalesce(jsonb_agg(e.label order by e.id), '[]') from public.request_events e where e.request_id = r.id))
                       order by r.created_at), '[]') from public.requests r where r.member_id = me.id),
    'told_you', (select coalesce(jsonb_agg(jsonb_build_object('at', u.created_at, 'words', u.body, 'your_answer', u.answer) order by u.created_at), '[]')
                  from public.client_updates u where me.role = 'client' and u.table_id = t
                   and (u.request_id is null or exists (select 1 from public.requests r where r.id = u.request_id and r.member_id = me.id))),
    'your_chat_with_your_ai', (select coalesce(jsonb_agg(jsonb_build_object('at', l.created_at, 'who', l.who, 'body', l.body) order by l.created_at), '[]')
                                from public.client_lines l where l.member_id = me.id));
end;
$$;
revoke all on function public.export_mine(uuid) from public, anon;
grant execute on function public.export_mine(uuid) to authenticated;

-- Delete a table for good: everything in it, the activity log included. The owner types the table's name to confirm.
create function public.delete_table(t uuid, confirm_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  n text;
begin
  if not public.is_owner(t) then
    raise exception 'only the owner deletes the table';
  end if;
  select name into n from public.tables where id = t;
  if btrim(coalesce(confirm_name, '')) <> n then
    raise exception 'type the table''s name exactly to delete it';
  end if;
  perform set_config('longtable.deleting_table', 'on', true);
  delete from public.tables where id = t;
end;
$$;
revoke all on function public.delete_table(uuid, text) from public, anon;
grant execute on function public.delete_table(uuid, text) to authenticated;
