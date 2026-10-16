-- Connect 0.1.24: a client's replies are written like Claude in a chat (an answer first, short lists, short paragraphs), never one
-- long block (17 Oct 2026, his words: "big block of text looks like too much").
update public.connect_release set version = '0.1.24', set_at = now();
