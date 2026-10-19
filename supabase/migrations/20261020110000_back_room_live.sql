-- The connection that tells the room what each AI is on within a second, as a path inside the project, and works at
-- medium effort unless its person picks another.
update public.connect_release set version = '0.1.28', set_at = now();
