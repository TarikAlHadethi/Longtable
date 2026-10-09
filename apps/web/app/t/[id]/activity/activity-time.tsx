"use client";

import { Time } from "@/components/time";

// Times are shown in the reader's own time zone, so they are drawn in the browser.
export function ActivityTime({ iso }: { iso: string }) {
  return (
    <span style={{ fontSize: 13, color: "var(--muted)", whiteSpace: "nowrap", minWidth: 110 }}>
      <Time iso={iso} style="stamp" />
    </span>
  );
}
