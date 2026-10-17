"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TableView } from "./t/[id]/table-view";
import type { Chat, Connection, Member } from "./t/[id]/types";

// The table's home, as a team sees it, on the opening page (his words, 17 Oct 2026: "exactly like this, but with more
// members... five members connect to the table with three clients"; then "animated... the same hover animations... be
// able to change the models just for fun... only 1 disconnect, preferably jonah"). It is the real table view with a
// made-up team and no database behind it: the models can be changed for show, and nothing is saved.
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
// Jonah's computer is off: his AI shows how a disconnected seat looks.
const OFF = "m4";
const CLAUDES = ["opus", "sonnet", "haiku"];
const CHATS: Chat[] = [{ id: "general", name: "General", about: "", is_general: true, created_at: "2026-10-01T09:00:00Z" }];
const nothing = () => {};

export function LandingTable() {
  const router = useRouter();
  const spot = useRef<HTMLDivElement>(null);
  // Drawn when it scrolls into view, so it sets itself out in front of the reader, the way the real one does.
  const [shown, setShown] = useState(false);
  const [now, setNow] = useState(0);
  const [models, setModels] = useState<Record<string, string>>(() => Object.fromEntries(AIS.map(([m, , model], i) => [`a${i}`, model])));
  const [tableModel, setTableModel] = useState("claude-sonnet-5-5");

  useEffect(() => {
    const el = spot.current;
    if (!el) return;
    const io = new IntersectionObserver((seen) => { if (seen.some((e) => e.isIntersecting)) { setShown(true); io.disconnect(); } }, { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // The seats that are on keep checking in, so they never go quiet while the page is open.
  useEffect(() => {
    if (!shown) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(t);
  }, [shown]);

  const connections: Connection[] = AIS.map(([member, kind], i) => {
    const seen = new Date(member === OFF ? now - 3 * 3600 * 1000 : now).toISOString();
    const model = models[`a${i}`];
    return { id: `a${i}`, member_id: member, kind, last_seen: seen, revoked_at: null, created_at: seen, model_choice: model,
      limits: { model, models: kind === "claude" ? CLAUDES : undefined } as Connection["limits"] };
  });

  return (
    // On a phone it is the same picture, scaled down to fit (Fit, on the opening page).
    <div ref={spot} style={{ width: "100%", minHeight: 560, display: "flex" }}>
      {shown && now > 0 && (
        <TableView table={{ id: "demo", name: "Fernhill Dental booking" }} me={PEOPLE[0]} members={PEOPLE} connections={connections} jobs={[]}
          online={new Set(["m1", "m2", "m3", "m5", "c1"])} messages={[]} chats={CHATS} onOpenChat={() => router.push("/demo")} onConnect={nothing}
          tableModel={tableModel} onTableModel={setTableModel} onModel={(conn, model) => setModels((m) => ({ ...m, [conn]: model }))} pickAny
          onPerson={nothing} onAi={nothing} onTable={nothing} />
      )}
    </div>
  );
}
