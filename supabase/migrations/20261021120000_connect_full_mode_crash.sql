-- The connection that no longer crashes when its person's full Claude Code gets a quick job (a counter read before
-- it was set, in 0.1.30 to 0.1.32), and whose lanes carry on past any job that goes wrong.
update public.connect_release set version = '0.1.33', set_at = now();
