-- Connect 0.1.40: the working copies it left in people's own repositories are tidied (an empty one goes with its
-- branch, one holding work loses only its folder after a quiet week, one with changes not committed is never touched).
update public.connect_release set version = '0.1.40', set_at = now();
