-- Connect 0.1.52: the shell their own terminal opens is PowerShell 7 when it is installed; the page is told which system
-- the shell runs on (ConPTY on Windows); a closed terminal window keeps its shell; their AI is told its browser is its
-- own person's alone. No change to the database itself.
update public.connect_release set version = '0.1.52', set_at = now();
