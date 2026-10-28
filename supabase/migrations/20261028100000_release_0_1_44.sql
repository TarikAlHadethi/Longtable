-- Connect 0.1.44: a client is answered like a chat, and quickly. The team's assistant and its deeper look into the
-- code wrote whole reports (a list of everything built and everything left) and ran on the strongest model, so a
-- simple "how close are we" took one to two minutes and filled the screen. Both now reply in a few short sentences,
-- offer more instead of saying it all, and run on a quick model with light effort. Nothing here changes the
-- database itself.
update public.connect_release set version = '0.1.44', set_at = now();
