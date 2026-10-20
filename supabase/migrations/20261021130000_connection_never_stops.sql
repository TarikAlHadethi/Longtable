-- The connection that never quietly stops: on Windows a watchdog in its start-up task brings it back within five minutes
-- (rewritten into every computer's task by the connection itself), a fault nobody foresaw is logged instead of ending
-- it, reconnecting replaces the old one cleanly, and tests can no longer touch the person's real start-up entry.
update public.connect_release set version = '0.1.34', set_at = now();
