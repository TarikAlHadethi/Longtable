-- Connect 0.1.51: a real terminal (their own shell in a pseudo-terminal, fetched once per computer from npm and checked
-- against the registry's fingerprint) and browser tabs with no limit. No change to the database itself.
update public.connect_release set version = '0.1.51', set_at = now();
