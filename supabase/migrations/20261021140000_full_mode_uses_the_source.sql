-- The connection whose full Claude Code works from, and pushes to, where the table reads the code: never the person's
-- own "origin", which can be somebody else's repository. On the person's own folder the work stays a local branch.
update public.connect_release set version = '0.1.35', set_at = now();
