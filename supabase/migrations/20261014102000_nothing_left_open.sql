-- Two kinds of job could stay open for ever. A view in a round whose table's answer had already been given up on
-- (its lead taken off, then the answer's computer gone) was never closed, because the round's clock stops looking
-- once a round has an answer; that view also kept the round's task "working" for ever. And an introduction queued
-- for, or taken by, a computer that then went away had nothing to time it out. Both are now closed by the clock that
-- already closes stuck answers. Found by the chaos run (rules E1 and E2: nothing stays open once its computer is gone).

CREATE OR REPLACE FUNCTION public.close_failed_tasks()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.jobs set status = 'skipped', lease_until = null, error = 'its computer never picked it up'
   where kind in ('combine', 'answer') and task_id is not null
     and ((status = 'running' and lease_until < now() - interval '10 minutes')
       or (status = 'queued' and created_at < now() - interval '10 minutes'
           and not exists (select 1 from public.connections cn where cn.member_id = jobs.member_id
                            and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds')));
  -- A round whose table's answer is finished, given up on or failed has nothing left to wait for: what it still has
  -- open (a view nobody took) is closed with it, or it stayed queued for ever and kept its task "working".
  update public.jobs j set status = 'skipped', lease_until = null, error = 'the round was already over'
   where j.round is not null and j.status in ('queued', 'running', 'waiting') and j.kind <> 'combine'
     and exists (select 1 from public.jobs c where c.round = j.round and c.kind = 'combine' and c.status in ('done', 'failed', 'skipped'));
  -- An introduction whose computer never took it, or stopped answering, is given up on the same way.
  update public.jobs set status = 'skipped', lease_until = null, error = 'its computer never picked it up'
   where kind = 'intro'
     and ((status = 'running' and lease_until < now() - interval '10 minutes')
       or (status = 'queued' and created_at < now() - interval '10 minutes'
           and not exists (select 1 from public.connections cn where cn.member_id = jobs.member_id
                            and cn.revoked_at is null and cn.last_seen > now() - interval '60 seconds')));
  update public.tasks t set status = 'stopped', finished_at = now()
   where t.status = 'working' and t.created_at < now() - interval '1 minute'
     and not exists (select 1 from public.jobs j where j.task_id = t.id and j.status in ('queued', 'running', 'waiting'))
     and not exists (select 1 from public.jobs w where w.task_id = t.id and w.round is not null and w.kind in ('plan', 'work')
                      and not exists (select 1 from public.jobs c where c.round = w.round and c.kind = 'combine'));
end;
$function$;
