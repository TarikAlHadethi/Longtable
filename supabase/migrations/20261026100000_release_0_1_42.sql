-- Connect 0.1.42: a client's copy is signed by the person whose computer makes it. Its own commits (its start, a
-- clean copy, catching up with the team, a take-back) were signed "Longtable", and Vercel's free plan refuses to
-- build a private repository's commit by anyone but the account's own, so the copy was never put up. The connection
-- now signs them with that person's git name and email, as it already did each change. Nothing here changes the
-- database itself.
update public.connect_release set version = '0.1.42', set_at = now();
