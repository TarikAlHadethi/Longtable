-- People joining a table show up live for the team, on the team channel.
create trigger members_broadcast after insert or update on public.members
  for each row execute function public.broadcast_team_change();

-- The delivery timer runs every two seconds, so trim its run history daily to keep it small.
select cron.schedule(
  'longtable-trim-timer-history',
  '17 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '1 day'$$
);
