"use client";

import { formatTime } from "@/lib/time";

// Times are shown in the reader's own time zone, so they are drawn in the browser.
export function ActivityTime({ iso }: { iso: string }) {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return (
    <span suppressHydrationWarning style={{ fontSize: 13, color: "var(--muted)", whiteSpace: "nowrap", minWidth: 110 }}>
      {day}, {formatTime(iso)}
    </span>
  );
}
