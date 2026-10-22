-- A message is heard after a second and a half of quiet, not four, and the listener is looked for every second, so an
-- answer starts about four seconds sooner. Someone typing a second message in a row still resets the wait.
-- Connect 0.1.39: updates only between jobs, a folder's address right on Mac and Linux, the note-taker reading only
-- what is new since its notes, a smaller listener, and quicker pick-up of jobs.

CREATE OR REPLACE FUNCTION public.hear_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.by_ai or new.kind <> 'chat' or coalesce(current_setting('longtable.asked', true), '') = '1' then
    return null;
  end if;
  if public.final_seat_now(new.table_id) is null then
    return null;
  end if;
  if exists (select 1 from public.chats ch where ch.id = new.chat_id and (not ch.set_up or ch.answers = 'silent')) then
    return null;
  end if;
  insert into public.listens (chat_id, table_id, since, due_at)
    values (new.chat_id, new.table_id, new.created_at, now() + interval '1.5 seconds')
    on conflict (chat_id) do update set due_at = excluded.due_at, since = least(public.listens.since, excluded.since);
  return null;
end;
$function$;

select cron.unschedule('longtable-listen');
select cron.schedule('longtable-listen', '1 seconds', 'select public.listen_now()');

update public.connect_release set version = '0.1.39', set_at = now();
