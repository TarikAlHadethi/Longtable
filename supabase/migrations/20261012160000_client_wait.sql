-- A client's question waits its turn fairly. The give-up clock ran from the moment they asked, so a question that
-- queued behind another job for a minute was passed on unanswered after 30 seconds of work. Now: three minutes to be
-- picked up, and 100 seconds to be answered once it is.

create or replace function public.client_job_timeouts()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  stale record;
  n integer := 0;
begin
  for stale in
    select id, status from public.jobs
     where kind = 'client'
       and ((status = 'queued' and created_at < now() - interval '180 seconds')
         or (status = 'running' and coalesce(started_at, created_at) < now() - interval '100 seconds'))
  loop
    perform public.give_up_client_job(stale.id, case when stale.status = 'queued' then 'not picked up in 3 minutes' else 'no answer in 100 seconds' end);
    n := n + 1;
  end loop;
  return n;
end;
$$;
