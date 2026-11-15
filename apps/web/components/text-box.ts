"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

// What is typed in a box survives a refresh (after an update, or any other), kept only in this tab.
export function useDraft(key: string): [string, Dispatch<SetStateAction<string>>] {
  const [draft, setDraft] = useState("");
  useEffect(() => { try { const kept = sessionStorage.getItem(key); if (kept) setDraft((d) => d || kept); } catch { /* storage off: nothing kept */ } }, [key]);
  useEffect(() => { try { if (draft) sessionStorage.setItem(key, draft); else sessionStorage.removeItem(key); } catch { /* storage off: nothing kept */ } }, [key, draft]);
  return [draft, setDraft];
}

// A box as tall as what is in it, up to a limit.
export function fitHeight(el: HTMLTextAreaElement | null, max = Infinity) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}
