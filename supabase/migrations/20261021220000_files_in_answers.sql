-- A person's own Claude can put a file or a picture into its answer (a screenshot it took, a spreadsheet it made), as
-- Claude in the app can send files: the connection uploads it into the table's attachments and it shows on the answer,
-- for the team, like anything attached in the chat. The connection has no sign-in to storage: it asks for a short-lived
-- upload place tied to its running job (only that job's key opens it), uploads there, and names the file to the job;
-- when its answer is written the job's files go with it.

alter table public.attachments add column job_id uuid references public.jobs(id) on delete set null;

create table public.upload_slots (
  key text primary key,
  job_id uuid not null references public.jobs(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  expires_at timestamptz not null
);
alter table public.upload_slots enable row level security;
revoke all on public.upload_slots from public, anon, authenticated;

-- Whether an upload place is open: its key, at that table, not yet expired, and still empty (one file per place, so a
-- place someone else saw cannot be filled up). Read by the storage rule below.
create function public.upload_slot_open(t text, folder text)
returns boolean language sql stable security definer set search_path = '' as $$
  select folder ~ '^ai-[0-9a-f]{32}$' and exists (select 1 from public.upload_slots s
    where s.key = substring(folder from 4) and s.table_id::text = t and s.expires_at > now())
    and not exists (select 1 from storage.objects o where o.bucket_id = 'attachments' and o.name like t || '/' || folder || '/%');
$$;
revoke all on function public.upload_slot_open(text, text) from public;
grant execute on function public.upload_slot_open(text, text) to anon, authenticated;

create policy "a running job uploads into its own open place" on storage.objects for insert to anon
  with check (bucket_id = 'attachments'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.upload_slot_open((storage.foldername(name))[1], (storage.foldername(name))[2]));

create function public.runner_upload_slot(key text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs := public.job_for_key(key);
  k text := encode(extensions.gen_random_bytes(16), 'hex');
begin
  if (select count(*) from public.attachments where job_id = j.id) >= 8 or (select count(*) from public.upload_slots where job_id = j.id) >= 12 then
    raise exception 'eight files at most in one answer';
  end if;
  insert into public.upload_slots (key, job_id, table_id, expires_at) values (k, j.id, j.table_id, now() + interval '10 minutes');
  delete from public.upload_slots where expires_at < now() - interval '1 day';
  return j.table_id::text || '/ai-' || k || '/';
end;
$$;
revoke all on function public.runner_upload_slot(text) from public, authenticated;
grant execute on function public.runner_upload_slot(text) to anon;

-- A file uploaded into this job's place, named to the job: it goes with the job's answer.
create function public.runner_attach(key text, path text, name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs := public.job_for_key(key);
  o record;
  mime text;
  made uuid;
begin
  if coalesce(path, '') !~ ('^' || j.table_id::text || '/ai-[0-9a-f]{32}/[0-9a-f-]{36}-[^/]{1,200}$')
     or not exists (select 1 from public.upload_slots s where s.job_id = j.id and s.key = substring(split_part(path, '/', 2) from 4)) then
    raise exception 'that file is not in this job''s place';
  end if;
  if (select count(*) from public.attachments where job_id = j.id) >= 8 then
    raise exception 'eight files at most in one answer';
  end if;
  select so.id, so.metadata into o from storage.objects so where so.bucket_id = 'attachments' and so.name = path;
  if not found then
    raise exception 'that file did not finish uploading';
  end if;
  mime := left(coalesce(nullif(o.metadata ->> 'mimetype', ''), 'application/octet-stream'), 120);
  insert into public.attachments (table_id, member_id, message_id, path, name, mime, size, kind, job_id)
    values (j.table_id, j.member_id, null, path, left(coalesce(nullif(btrim(name), ''), 'file'), 200), mime,
            coalesce((o.metadata ->> 'size')::bigint, 0),
            case when mime like 'image/%' then 'image' when mime like 'video/%' then 'video' when mime like 'audio/%' then 'audio' else 'file' end, j.id)
    returning id into made;
  return made;
end;
$$;
revoke all on function public.runner_attach(text, text, text) from public, authenticated;
grant execute on function public.runner_attach(text, text, text) to anon;

-- Once its answer is written, the job's files go on it, shown like anything attached in the chat.
create function public.runner_attach_answer(token text, job uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  c public.connections := public.connection_for(token);
  j public.jobs;
  files jsonb;
begin
  select * into j from public.jobs where id = job and member_id = c.member_id;
  if not found or j.result_message_id is null then
    return 0;
  end if;
  -- A part of a round (its work, a view, a review) writes to the back room: its files wait for the round's one answer,
  -- which takes the files of every part of the round.
  if j.round is not null and j.kind <> 'combine' then
    return 0;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'mime', a.mime, 'size', a.size, 'path', a.path, 'kind', a.kind) order by a.created_at), '[]'::jsonb)
    into files from public.attachments a
   where a.message_id is null and a.table_id = j.table_id
     and (a.job_id = j.id or (j.kind = 'combine' and j.round is not null and a.job_id in (select rj.id from public.jobs rj where rj.round = j.round)));
  if jsonb_array_length(files) = 0 then
    return 0;
  end if;
  update public.attachments a set message_id = j.result_message_id
   where a.message_id is null and a.table_id = j.table_id
     and (a.job_id = j.id or (j.kind = 'combine' and j.round is not null and a.job_id in (select rj.id from public.jobs rj where rj.round = j.round)));
  update public.messages set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('files', coalesce(meta -> 'files', '[]'::jsonb) || files)
   where id = j.result_message_id;
  return jsonb_array_length(files);
end;
$$;
revoke all on function public.runner_attach_answer(text, uuid) from public, authenticated;
grant execute on function public.runner_attach_answer(text, uuid) to anon;
