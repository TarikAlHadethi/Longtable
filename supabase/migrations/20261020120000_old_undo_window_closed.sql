-- The 10-second undo window is closed for good (20 Oct 2026). decide_and_send (17 Oct) is the only way a team member
-- decides, and it delivers at once. decide and undo_decision were still granted to authenticated, so a team member
-- calling them directly could still take the old window. Nothing in the app calls decide any more; the decision card's
-- Undo only shows for an old-window decision still open, and those end within five minutes of this migration.
revoke all on function public.decide(uuid, smallint), public.undo_decision(uuid) from public, anon, authenticated;
