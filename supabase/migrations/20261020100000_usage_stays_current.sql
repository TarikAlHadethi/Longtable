-- The connection that keeps Usage current: the plan's use is reported after every message the table hears, not only
-- after bigger jobs.
update public.connect_release set version = '0.1.27', set_at = now();
