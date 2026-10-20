-- The connection whose stand-in (started by connect when the start-up task was slow) never ends the real background
-- connection, and which waits longer for the start-up task and says plainly when it could not start in the background.
update public.connect_release set version = '0.1.32', set_at = now();
