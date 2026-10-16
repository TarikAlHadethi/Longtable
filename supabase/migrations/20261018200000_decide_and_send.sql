-- A decision is picked, its words looked over and changed if need be, then sent (17 Oct 2026, his recording: "it
-- shouldn't just be decided... it should show what Elena would be told, but the text should be editable, and there
-- should be a send"; and on when she hears it: at once). Pressing an option no longer decides on its own, and there is
-- no undo window any more: Send is the confirming step.
--
-- decide_and_send(d, choice, words): the team picks `choice`; when the decision tells a client, `words` (the option's
-- words as the person left them) replace that option's words and go out now. A question for the client keeps its
-- answers to tap; only the question's words can be changed.

create or replace function public.decide_and_send(d uuid, choice smallint, words text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  dec public.decisions;
  opt public.decision_options;
  me uuid;
  said text := btrim(coalesce(words, ''));
begin
  select * into dec from public.decisions where id = d for update;
  if not found or not public.is_team(dec.table_id) then
    raise exception 'only the team can decide';
  end if;
  if dec.status <> 'open' then
    raise exception 'this decision is already made';
  end if;
  select * into opt from public.decision_options where decision_id = d and position = choice;
  if not found then
    raise exception 'that option does not exist';
  end if;
  if dec.affects_client then
    if said = '' then
      said := btrim(opt.client_words);
    end if;
    if said = '' then
      raise exception 'write what the client will be told';
    end if;
    if char_length(said) > 2000 then
      raise exception 'what the client is told can be at most 2000 characters';
    end if;
    update public.decision_options set client_words = said where decision_id = d and position = choice;
  end if;
  me := public.my_member_id(dec.table_id);
  update public.decisions
     set status = 'decided', chosen = choice, decided_by = me, decided_at = now(), deliver_after = now()
   where id = d;
  perform public.log_activity(dec.table_id, me, 'decision.decided', d,
    jsonb_build_object('title', dec.title, 'option', opt.label, 'edited', dec.affects_client and said <> btrim(opt.client_words)));
  -- Out now, not on the scheduler's next beat.
  perform public.deliver_due();
end;
$$;
revoke all on function public.decide_and_send(uuid, smallint, text) from public, anon;
grant execute on function public.decide_and_send(uuid, smallint, text) to authenticated;
