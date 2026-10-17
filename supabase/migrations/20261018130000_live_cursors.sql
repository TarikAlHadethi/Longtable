-- Live cursors on pages (16 Oct 2026): a named pointer for each person looking at a page, as in a shared
-- document.
--
-- Each table has one more channel, `cursor:<table>`, where the team's open pages say where each person's pointer is
-- and who is writing a comment. Only the team of that table may listen or send there; a client, someone removed or
-- anyone at another table may do neither. What goes over it is a member id, a page id and a place on the page: the
-- name and colour shown come from each viewer's own list of the table's people. Nothing is stored.

create function public.cursor_topic_table_id(topic text)
returns uuid language sql immutable set search_path = '' as $$
  select case when topic ~ '^cursor:[0-9a-f-]{36}$' then substring(topic from 8)::uuid else null end;
$$;
revoke all on function public.cursor_topic_table_id(text) from public, anon;
grant execute on function public.cursor_topic_table_id(text) to authenticated;

create policy "the team hears where its people point" on realtime.messages for select to authenticated
  using (public.is_team(public.cursor_topic_table_id(realtime.topic())));
create policy "the team says where it points" on realtime.messages for insert to authenticated
  with check (extension = 'broadcast' and public.is_team(public.cursor_topic_table_id(realtime.topic())));
