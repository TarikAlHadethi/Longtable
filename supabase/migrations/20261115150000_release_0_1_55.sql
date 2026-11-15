-- Connect 0.1.55: the terminal is served from a process of its own, so nothing the connection does (a git fetch,
-- listing processes) holds up what a person types; one list of secret file names for opening, sharing and the type
-- check. The rest is the same code moved into clearer files, with every word an AI is handed unchanged.
update public.connect_release set version = '0.1.55', set_at = now();
