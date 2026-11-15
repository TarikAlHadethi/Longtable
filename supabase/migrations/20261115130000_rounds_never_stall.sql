-- A round in a chat turned to "No AI" while its work was open can never finish: finishing needs one more job in that
-- chat, which the room refuses (jobs_never_in_no_ai_room). advance_rounds moved every open round in one loop, so that
-- one refusal, raised again every two seconds, stopped every round at every table: views were never skipped, plans
-- never started. Found by the free database suites, which leave such rooms behind (step29, sim-rounds).
-- Now a round in a chat no AI hears is left alone, each round moves on in its own error boundary (a fault in one is
-- written down and the rest go on), and turning a chat off stops the work under way in it, as it already ends the
-- jobs, so no task stays "working" for ever.

create or replace function public.advance_rounds()
returns void language plpgsql security definer set search_path = '' as $$
declare
  r uuid;
begin
  for r in select distinct w.round from public.jobs w
            where w.round is not null and w.kind in ('plan', 'work') and w.created_at > now() - interval '30 days'
              and not exists (select 1 from public.jobs c where c.round = w.round and c.kind = 'combine')
              and not exists (select 1 from public.chats ch where ch.id = w.chat_id and ch.answers = 'off') loop
    begin
      perform public.advance_round(r);
    exception when others then
      raise warning 'tripwire: a round could not move on: %', sqlerrm;
    end;
  end loop;
end;
$$;
revoke all on function public.advance_rounds() from public, anon, authenticated;

create or replace function public.chat_off_ends_work() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.tasks set status = 'stopped', finished_at = now() where chat_id = new.id and status = 'working';
  return new;
end;
$$;
revoke all on function public.chat_off_ends_work() from public, anon, authenticated;
create trigger chats_off_end_work after update of answers on public.chats
  for each row when (new.answers = 'off' and old.answers is distinct from 'off') execute function public.chat_off_ends_work();

-- What is already stuck that way.
update public.tasks t set status = 'stopped', finished_at = now()
 where t.status = 'working' and exists (select 1 from public.chats ch where ch.id = t.chat_id and ch.answers = 'off');
