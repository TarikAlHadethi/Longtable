-- Unpinning a note. The pinned notes are what each AI wrote when it joined: a summary of the project, and what it
-- can check. Anyone on the team may take one down; it is gone for everyone, and no AI is handed it any more.

create function public.unpin_note(n uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  note public.notes;
begin
  select * into note from public.notes where id = n;
  if not found or not public.is_team(note.table_id) then
    raise exception 'only the team can unpin a note';
  end if;
  delete from public.notes where id = n;
  perform public.log_activity(note.table_id, public.my_member_id(note.table_id), 'note.unpinned', n, jsonb_build_object('title', note.title, 'kind', note.kind));
  perform realtime.send(jsonb_build_object('table', 'notes', 'record', jsonb_build_object('id', n, 'deleted', true)),
    'UPDATE', 'team:' || note.table_id::text, true);
end;
$$;
revoke all on function public.unpin_note(uuid) from public, anon;
grant execute on function public.unpin_note(uuid) to authenticated;
