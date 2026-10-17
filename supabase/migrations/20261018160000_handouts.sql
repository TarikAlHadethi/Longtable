-- Handouts (17 Oct 2026: a livelier name than Pages for everything the AIs make, that breaks no
-- one's trademark). What the table's AIs make is called a handout on every screen; the tables keep their names.
-- A comment sent to the AIs now says so. And every connection is asked to move to 0.1.21, the first version to
-- arrive by itself.

CREATE OR REPLACE FUNCTION public.comment_page(p uuid, body text, anchor text DEFAULT ''::text, parent uuid DEFAULT NULL::uuid, to_ai boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  pg public.pages := public.team_page(p);
  me uuid := public.my_member_id(pg.table_id);
  words text := btrim(coalesce(body, ''));
  picked text := left(btrim(coalesce(anchor, '')), 300);
  made uuid;
begin
  if char_length(words) = 0 or char_length(words) > 4000 then
    raise exception 'a comment is between 1 and 4,000 characters';
  end if;
  if parent is not null and not exists (select 1 from public.page_comments where page_comments.id = parent and page_id = pg.id) then
    raise exception 'that reply is not to a comment on this page';
  end if;
  if (select count(*) from public.page_comments where member_id = me and created_at > now() - interval '1 hour') >= 120 then
    raise exception 'that is a lot of comments for one hour; try again a little later';
  end if;
  insert into public.page_comments (page_id, table_id, member_id, parent_id, version, anchor, body, to_ai)
    values (pg.id, pg.table_id, me, parent, pg.version, picked, words, to_ai)
    returning page_comments.id into made;
  update public.pages set touched_at = now() where pages.id = pg.id;
  if to_ai then
    perform public.ask_table(pg.chat_id, left(format('On the handout "%s"%s: %s', pg.title,
      case when picked <> '' then format(', where it says "%s"', picked) else '' end, words), 8000), '[]'::jsonb);
  end if;
  return made;
end;
$function$
;

update public.connect_release set version = '0.1.21', set_at = now();
