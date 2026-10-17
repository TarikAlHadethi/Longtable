-- Connect 0.1.24: a client's replies are written like Claude in a chat (an answer first, short lists, short paragraphs), never one
-- long block, which reads as too much (17 Oct 2026).
update public.connect_release set version = '0.1.24', set_at = now();
