-- A lighter database, measured on the live one (22 Oct 2026): every runner call rewrote its connection's row, so the
-- two lanes and the heartbeats queued behind each other's row lock (a claim timed out at its 3 s limit) and every
-- write went out as a live broadcast to the team; six timers fired 2.9 times a second, each in a fresh backend; the
-- timer history was trimmed once a day in one 4 to 8 second delete; and a chat's messages were checked for who may read
-- them once per row.

-- 1. "Last seen" is written at most every 15 seconds, and never waited for: a call that finds the row busy carries on.
-- Everything that asks whether a computer is on looks back 60 seconds or more.
CREATE OR REPLACE FUNCTION public.connection_for(token text)
 RETURNS connections
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.connections;
begin
  select * into c from public.connections
    where token_hash = encode(extensions.digest(token, 'sha256'), 'hex') and revoked_at is null;
  if not found or exists (select 1 from public.members m where m.id = c.member_id and m.removed_at is not null) then
    raise exception 'this connection was removed; connect again from Longtable';
  end if;
  if c.last_seen is null or c.last_seen < now() - interval '15 seconds' then
    update public.connections set last_seen = now()
     where id = (select id from public.connections where id = c.id for update skip locked);
  end if;
  return c;
end;
$function$;

-- 2. One timer, every second, does what six did: each part on its own beat, and a fault in one never stops the rest.
create or replace function public.tick()
returns void language plpgsql security definer set search_path = '' as $$
declare
  s integer := extract(epoch from now())::integer;
begin
  begin perform public.listen_now(); exception when others then raise warning 'tripwire: listen_now %', sqlerrm; end;
  if s % 2 = 0 then
    begin perform public.release_rounds(); exception when others then raise warning 'tripwire: release_rounds %', sqlerrm; end;
    begin perform public.advance_rounds(); exception when others then raise warning 'tripwire: advance_rounds %', sqlerrm; end;
    begin perform public.deliver_due(); exception when others then raise warning 'tripwire: deliver_due %', sqlerrm; end;
  end if;
  if s % 5 = 0 then
    begin perform public.client_job_timeouts(); exception when others then raise warning 'tripwire: client_job_timeouts %', sqlerrm; end;
  end if;
  if s % 10 = 0 then
    begin perform public.close_sandbox(); exception when others then raise warning 'tripwire: close_sandbox %', sqlerrm; end;
  end if;
end;
$$;
revoke all on function public.tick() from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job
 where jobname in ('longtable-listen', 'longtable-release-rounds', 'longtable-advance-rounds', 'longtable-deliver-due', 'longtable-client-timeouts', 'longtable-close-sandbox');
select cron.schedule('longtable-tick', '1 seconds', 'select public.tick()');

-- 3. The timer history is trimmed every ten minutes, two hours kept, in small deletes.
select cron.unschedule('longtable-trim-timer-history');
select cron.schedule('longtable-trim-timer-history', '*/10 * * * *', $$delete from cron.job_run_details where end_time < now() - interval '2 hours'$$);

-- 4. The room reads a table's jobs by time.
create index if not exists jobs_table_time_idx on public.jobs (table_id, created_at desc);

-- 5. Who may read a chat's messages, worked out once per read instead of once per message. The same rule as
-- can_see_chat: the team of its table, and for a private chat only its people.
create or replace function public.my_visible_chats()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select ch.id
    from public.members m join public.chats ch on ch.table_id = m.table_id
   where m.user_id = auth.uid() and m.removed_at is null and m.role in ('owner', 'developer')
     and (not ch.private or exists (select 1 from public.chat_people p where p.chat_id = ch.id and p.member_id = m.id));
$$;
revoke all on function public.my_visible_chats() from public, anon;
grant execute on function public.my_visible_chats() to authenticated;

alter policy "the team reads its messages, a private chat's only its people" on public.messages
  using (chat_id in (select public.my_visible_chats()));
