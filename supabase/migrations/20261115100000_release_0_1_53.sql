-- Connect 0.1.53: several terminals at once (a tab each on their page, each its own shell, listed for a page opened
-- later), and every browser picture says which tab it is of, so switching tabs never shows another tab's page. No
-- change to the database itself.
update public.connect_release set version = '0.1.53', set_at = now();
