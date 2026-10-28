-- "ok so i want to test for 25 students, is it ready?" went to the client's copy: "i want" counted as asking for a
-- change, and that beat the question mark. Now a message that ends in a question mark is a question unless it asks
-- for a change outright ("can you make it bigger?", "is it possible to add a filter?"), and a wish ("I want",
-- "we need") is a change only when what follows is a thing or a change ("I want a dark mode", "I'd like to add a
-- filter"), never "I want to test it". (\y is a word edge in Postgres patterns.)

create or replace function public.is_change(words text) returns boolean language sql immutable set search_path = '' as $$
  with w as (
    select regexp_replace(lower(btrim(coalesce(words, ''))),
      '^((ok|okay|so|hey|hi|hello|um|uh|and|but|also|well|alright|right|then|yeah|yes|actually)[\s,.!:-]+)+', '') as s
  ), c as (
    select s,
      s ~ '^(can|could|would|will|can''t|cannot)\s+(you|we|u)\s+(please\s+)?(make|change|add|remove|delete|put|move|turn|set|show|hide|rename|fix|update|use|swap|replace|switch|give|let|bring|drop|take|increase|decrease|enlarge|shrink|center|centre|align|bold|colou?r|translate|sort|reorder|redesign|style|edit|resize|recolou?r)\y'
        or s ~ '^is it possible to\s+(make|change|add|remove|delete|put|move|turn|set|show|hide|rename|fix|update|use|swap|replace|switch|give|let|bring|drop|take|increase|decrease|enlarge|shrink|center|centre|align|bold|colou?r|translate|sort|reorder|redesign|style|edit|resize|recolou?r)\y' as asks,
      s ~ '^(please\s+)?(make|change|add|remove|delete|put|move|turn|set|show|hide|rename|fix|update|use|swap|replace|switch|give|let|bring|drop|take|increase|decrease|enlarge|shrink|center|centre|align|bold|colou?r|translate|sort|reorder|redesign|style|edit|resize|recolou?r)\y'
        or s ~ '^(i want|i''d like|i would like|i need|we need|we want)\s+((you|them|it)\s+to\s+(make|change|add|remove|delete|put|move|turn|set|show|hide|rename|fix|update|use|swap|replace|switch|give|let|bring|drop|take|increase|decrease|enlarge|shrink|center|centre|align|bold|colou?r|translate|sort|reorder|redesign|style|edit|resize|recolou?r)|to\s+(make|change|add|remove|delete|put|move|turn|set|show|hide|rename|fix|update|use|swap|replace|switch|give|let|bring|drop|take|increase|decrease|enlarge|shrink|center|centre|align|bold|colou?r|translate|sort|reorder|redesign|style|edit|resize|recolou?r)|(a|an|the|it|this|that|these|those|some|more|less|my|our)\y)'
        or s ~ '^(let''s|lets)\s+(make|change|add|remove|delete|put|move|turn|set|show|hide|rename|fix|update|use|swap|replace|switch|give|let|bring|drop|take|increase|decrease|enlarge|shrink|center|centre|align|bold|colou?r|translate|sort|reorder|redesign|style|edit|resize|recolou?r)\y'
        or s ~ '\y(should be|should have|should say|should look|needs to be|need to be|has to be|instead of)\y'
        or s ~ '\y(make|change|add|remove|delete|put|move|turn|set|show|hide|rename|fix|update|use|swap|replace|switch|give|let|bring|drop|take|increase|decrease|enlarge|shrink|center|centre|align|bold|colou?r|translate|sort|reorder|redesign|style|edit|resize|recolou?r)\s+(the|a|an|it|this|that|these|those|my|our|its|some|all)\y' as wants
    from w
  )
  select asks or (wants and s !~ '\?\s*$' and public.is_question(words) is not true) from c;
$$;
