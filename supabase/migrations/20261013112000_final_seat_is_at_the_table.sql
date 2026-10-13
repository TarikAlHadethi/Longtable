-- Someone taken off the table could still be picked to write the table's answer.

CREATE OR REPLACE FUNCTION public.set_final_seat(t uuid, seat uuid, offline text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.is_owner(t) then
    raise exception 'only the owner changes who writes the final answer';
  end if;
  if seat is not null and not exists (select 1 from public.members where id = seat and table_id = t and role in ('owner', 'developer') and removed_at is null) then
    raise exception 'the final answer has to come from someone on the team';
  end if;
  if offline not in ('wait', 'next') then
    raise exception 'unknown choice';
  end if;
  update public.tables set final_seat = seat, when_final_offline = offline where id = t;
  perform public.log_activity(t, public.my_member_id(t), 'settings.final_seat', seat, jsonb_build_object('offline', offline));
end;
$$;
