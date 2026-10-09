"use client";

import { useSyncExternalStore } from "react";
import { formatStamp, formatTime, formatWhen } from "@/lib/time";

const never = () => () => {};

// True once the page is running in the browser. The server answers false, so the first paint matches it exactly.
export function useInBrowser() {
  return useSyncExternalStore(never, () => true, () => false);
}

// A time in the reader's own time zone. The server cannot know that zone, so it draws nothing and the browser
// fills it in; a server-drawn time would stay wrong, because React does not repaint text it was told to ignore.
export function Time({ iso, style = "time" }: { iso: string; style?: "time" | "when" | "stamp" }) {
  const here = useInBrowser();
  if (!here) return null;
  return <>{style === "when" ? formatWhen(iso) : style === "stamp" ? formatStamp(iso) : formatTime(iso)}</>;
}
