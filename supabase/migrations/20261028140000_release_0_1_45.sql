-- Connect 0.1.45: a client asking whether the project is ready ("is it ready for 25 students?") was told the team
-- would get back to them. The team's assistant now looks at the project and answers, adding that the go-ahead is the
-- team's. Nothing here changes the database itself.
update public.connect_release set version = '0.1.45', set_at = now();
