"use client";

import { useEffect, useState } from "react";
import { TableView } from "./t/[id]/table-view";
import type { Chat, Connection, Member } from "./t/[id]/types";

// The table's home, as a team sees it, on the opening page (his words, 17 Oct 2026: "exactly like this, but with more
// members... five members connect to the table with three clients"). It is the real table view with a made-up team
// and nothing behind it: no database, nothing to press.
const PEOPLE: Member[] = [
  { id: "m1", display_name: "Maya", role: "owner", color: "oklch(0.62 0.12 30)" },
  { id: "m2", display_name: "Sam", role: "developer", color: "oklch(0.6 0.1 250)" },
  { id: "m3", display_name: "Priya", role: "developer", color: "oklch(0.62 0.1 150)" },
  { id: "m4", display_name: "Jonah", role: "developer", color: "oklch(0.62 0.1 70)" },
  { id: "m5", display_name: "Aisha", role: "developer", color: "oklch(0.6 0.1 310)" },
  { id: "c1", display_name: "Elena Ruiz", role: "client", color: "oklch(0.6 0.1 340)" },
  { id: "c2", display_name: "Tom Becker", role: "client", color: "oklch(0.58 0.08 200)" },
  { id: "c3", display_name: "Grace Lin", role: "client", color: "oklch(0.6 0.09 110)" },
];
const AIS: [string, "claude" | "codex", string][] = [
  ["m1", "claude", "claude-opus-5-5"], ["m2", "claude", "claude-sonnet-5-5"], ["m3", "codex", "GPT-5.5"],
  ["m4", "claude", "claude-opus-5-5"], ["m5", "codex", "GPT-5.5"],
];
const CHATS: Chat[] = [{ id: "general", name: "General", about: "", is_general: true, created_at: "2026-10-01T09:00:00Z" }];
const nothing = () => {};

export function LandingTable() {
  // Drawn once the page is in the browser: the seats count as on by the browser's own clock.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  if (now === null) return <div style={{ minHeight: 560 }} />;
  const seen = new Date(now).toISOString();
  const connections: Connection[] = AIS.map(([member, kind, model], i) => ({
    id: `a${i}`, member_id: member, kind, last_seen: seen, revoked_at: null, created_at: seen, model_choice: model, limits: { model } as Connection["limits"],
  }));
  return (
    <div inert style={{ display: "flex", width: "100%" }}>
      <TableView table={{ id: "demo", name: "Fernhill Dental booking" }} me={PEOPLE[0]} members={PEOPLE} connections={connections} jobs={[]}
        online={new Set(["m1", "m2", "m3", "c1"])} messages={[]} chats={CHATS} onOpenChat={nothing} onConnect={nothing}
        tableModel="claude-sonnet-5-5" onTableModel={nothing} onPerson={nothing} onAi={nothing} onTable={nothing} />
    </div>
  );
}
