-- Functions nothing calls any more. is_question and is_change routed a client's words by their wording until the
-- client's assistant decided instead (20261028150000); server_now timed the old undo countdown, gone with it. No
-- connection version ever called any of them.
drop function if exists public.is_change(text);
drop function if exists public.is_question(text);
drop function if exists public.server_now();
