"use client";

import { useEffect, useRef, useState } from "react";
import s from "./update-notice.module.css";

const MINE = process.env.NEXT_PUBLIC_BUILD || "dev";

// A refresh by itself happens at most once for each newer build, so a page that somehow still loads the old one (a
// cache in the way) never refreshes again and again for nothing: it only shows the note.
function refreshOnceFor(build: string) {
  try {
    if (sessionStorage.getItem("lt-refreshed-for") === build) return false;
    sessionStorage.setItem("lt-refreshed-for", build);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

// Nothing half typed, no window open: a refresh would lose nothing.
function safeToRefresh() {
  const typed = [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, input[type=text], input:not([type])")].some((el) => el.value.trim() !== "");
  return !typed && !document.querySelector("[role=dialog]");
}

// When a newer Longtable goes live, an open page says so and offers to refresh; it refreshes by itself only while it
// is in the background with nothing typed and no window open. What an AI is doing goes on either way: a refresh only
// redraws the page.
export function UpdateNotice() {
  const [newer, setNewer] = useState(false);
  const known = useRef<string | null>(null);
  useEffect(() => {
    if (MINE === "dev") return;
    let stop = false;
    const check = async () => {
      try {
        const { build } = await (await fetch("/api/version", { cache: "no-store" })).json();
        if (stop || !build || build === "dev" || build === MINE) return;
        if (document.hidden && safeToRefresh() && refreshOnceFor(build)) return;
        known.current = build;
        setNewer(true);
      } catch {
        // Offline or between deploys: asked again at the next check.
      }
    };
    const timer = setInterval(check, 3 * 60 * 1000);
    // Once a newer one is known, the moment the page goes to the background with nothing typed is the moment to refresh.
    const onShow = () => { if (!document.hidden) check(); else if (known.current && safeToRefresh()) refreshOnceFor(known.current); };
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", check);
    check();
    return () => { stop = true; clearInterval(timer); document.removeEventListener("visibilitychange", onShow); window.removeEventListener("focus", check); };
  }, []);
  if (!newer) return null;
  return (
    <div className={s.note} role="status" data-testid="update-notice">
      Longtable has been updated.
      <button type="button" onClick={() => window.location.reload()}>Refresh</button>
    </div>
  );
}
