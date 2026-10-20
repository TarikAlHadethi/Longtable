-- The connection that installs Claude Code with Anthropic's installer when a computer has none it can run, and finds
-- the Claude app's own copy where Windows keeps it for the packaged app.
update public.connect_release set version = '0.1.31', set_at = now();
