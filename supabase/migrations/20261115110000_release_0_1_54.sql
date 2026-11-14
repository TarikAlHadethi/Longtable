-- Connect 0.1.54: the browser at the table is gone (his word); the bridge serves only terminals, and their AI's own
-- browser ("Let it open pages") is a fresh, isolated one again. No change to the database itself.
update public.connect_release set version = '0.1.54', set_at = now();
