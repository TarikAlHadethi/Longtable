"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { browserClient } from "@/lib/supabase/browser";
import { PAGE_COLUMNS, PAGE_COMMENT_COLUMNS, PAGE_VERSION_COLUMNS, type Page, type PageComment, type PageValue, type PageVersion } from "./types";

// The pages the table's AIs made, what each version was, what people said on them, what tools on them keep, and
// which ones this person pinned. The team's alone: a client never reads any of it.
export function usePages(supabase: ReturnType<typeof browserClient>, table: string, me: string) {
  const [pages, setPages] = useState<Page[]>([]);
  const [pageVersions, setPageVersions] = useState<PageVersion[]>([]);
  const [pageComments, setPageComments] = useState<PageComment[]>([]);
  const [pageValues, setPageValues] = useState<PageValue[]>([]);
  const [pins, setPins] = useState<Set<string>>(new Set());
  const [openPage, setOpenPage] = useState<string | null>(null);
  const [pagesOpen, setPagesOpen] = useState(false);
  const [viewing, setViewing] = useState<Map<string, string[]>>(new Map());
  const readPages = useCallback(async () => {
    const [pg, vs, cm, st, pn] = await Promise.all([
      supabase.from("pages").select(PAGE_COLUMNS).eq("table_id", table).order("touched_at", { ascending: false }).limit(200),
      supabase.from("page_versions").select(PAGE_VERSION_COLUMNS).eq("table_id", table).order("n").limit(2000),
      supabase.from("page_comments").select(PAGE_COMMENT_COLUMNS).eq("table_id", table).order("created_at").limit(2000),
      supabase.from("page_state").select("page_id, key, value, updated_by, updated_at").eq("table_id", table).limit(5000),
      supabase.from("page_pins").select("page_id").eq("member_id", me),
    ]);
    const bad = [pg, vs, cm, st, pn].find((r) => r.error);
    if (bad) { console.warn("[pages] could not be read:", bad.error?.code); return; }
    setPages(pg.data as Page[]);
    setPageVersions(vs.data as PageVersion[]);
    setPageComments(cm.data as PageComment[]);
    setPageValues(st.data as PageValue[]);
    setPins(new Set((pn.data as { page_id: string }[]).map((x) => x.page_id)));
  }, [supabase, table, me]);
  useEffect(() => { readPages(); }, [readPages]);

  // A live change to a page, one of its versions, a comment or a kept value. False for anything else.
  const applyPage = useCallback((name: string | undefined, record: Record<string, unknown>) => {
    if (name === "pages") {
      const p = record as unknown as Page & { deleted?: boolean };
      if (p.deleted) { setPages((prev) => prev.filter((x) => x.id !== p.id)); setOpenPage((cur) => (cur === p.id ? null : cur)); return true; }
      setPages((prev) => [p, ...prev.filter((x) => x.id !== p.id)]);
    } else if (name === "page_versions") {
      const v = record as unknown as PageVersion;
      setPageVersions((prev) => [...prev.filter((x) => x.id !== v.id), v]);
    } else if (name === "page_comments") {
      const c = record as unknown as PageComment;
      setPageComments((prev) => [...prev.filter((x) => x.id !== c.id), c]);
    } else if (name === "page_state") {
      const v = record as unknown as PageValue;
      setPageValues((prev) => [...prev.filter((x) => !(x.page_id === v.page_id && x.key === v.key)), v]);
    } else return false;
    return true;
  }, []);

  // Which pages each job made or changed, so an answer shows the handouts that came with it.
  const pagesByJob = useMemo(() => {
    const map = new Map<string, Page[]>();
    for (const p of pages) {
      const jobs = new Set([p.job_id, ...pageVersions.filter((v) => v.page_id === p.id).map((v) => v.job_id)].filter(Boolean) as string[]);
      for (const j of jobs) map.set(j, [...(map.get(j) ?? []), p]);
    }
    return map;
  }, [pages, pageVersions]);

  return { pages, pageVersions, pageComments, pageValues, pins, setPins, openPage, setOpenPage, pagesOpen, setPagesOpen, viewing, setViewing, readPages, applyPage, pagesByJob };
}
