"use client";

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

// When each person last had a Longtable tab open at this table. The page says it is here when it opens, when the tab
// comes back and every few minutes while it is in view; the team (never a client) reads everyone's once a minute.
export function useLastSeen(supabase: SupabaseClient, table: string, team: boolean, on = true) {
  const [seen, setSeen] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    if (!on) return;
    let gone = false;
    const say = () => {
      if (document.visibilityState !== "visible") return;
      supabase.rpc("i_am_here", { t: table }).then(({ error }) => { if (error) console.warn("[last seen] could not be said:", error.code); });
    };
    const read = () => {
      if (!team) return;
      supabase.rpc("last_seen", { t: table }).then(({ data, error }) => {
        if (error) { console.warn("[last seen] could not be read:", error.code); return; }
        if (!gone && data) setSeen(new Map((data as { member_id: string; at: string }[]).map((r) => [r.member_id, r.at])));
      });
    };
    const back = () => { if (document.visibilityState === "visible") { say(); read(); } };
    say();
    read();
    const saying = setInterval(say, 4 * 60 * 1000);
    const reading = setInterval(read, 60 * 1000);
    document.addEventListener("visibilitychange", back);
    return () => { gone = true; clearInterval(saying); clearInterval(reading); document.removeEventListener("visibilitychange", back); };
  }, [supabase, table, team, on]);
  return seen;
}
