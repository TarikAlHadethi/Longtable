-- New job states for the back room, in their own migration: a new enum value cannot be used in the transaction
-- that adds it.
alter type public.job_status add value if not exists 'waiting';
alter type public.job_status add value if not exists 'skipped';
