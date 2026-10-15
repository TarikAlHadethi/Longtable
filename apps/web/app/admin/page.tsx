import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Mark } from "@/components/mark";
import { serverClient } from "@/lib/supabase/server";

// The operator's page: how this Longtable is doing, in counts only. Anyone not listed as an operator gets a 404.
const LABELS: [string, string][] = [
  ["tables", "Tables"],
  ["tables_active_7d", "Tables active this week"],
  ["people", "People"],
  ["clients", "Of them, clients"],
  ["messages_24h", "Messages today"],
  ["messages_7d", "Messages this week"],
  ["decisions_7d", "Decisions this week"],
  ["client_requests_7d", "Client requests this week"],
  ["ai_connected", "AIs connected"],
  ["ai_codex", "Of them, Codex"],
  ["ai_on_now", "AIs on right now"],
  ["jobs_done_7d", "AI answers this week"],
  ["jobs_failed_7d", "AI jobs that failed this week"],
  ["answer_seconds_median_7d", "Median seconds to an answer"],
];

export default async function Admin() {
  const supabase = await serverClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in?next=/admin");
  const { data, error } = await supabase.rpc("operator_counts");
  if (error || !data) notFound();
  const counts = data as Record<string, number | null>;
  const { data: bugData, error: bugError } = await supabase.rpc("operator_bugs");
  const bugs = (bugData ?? []) as { id: string; body: string; place: string; browser: string; at: string }[];
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 20px", display: "flex", flexDirection: "column", gap: 20 }}>
      <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 600, color: "var(--ink)", textDecoration: "none" }}>
        <Mark size={24} /> Longtable
      </Link>
      <h1 style={{ margin: 0, fontSize: 26 }}>How it is going</h1>
      <p className="note" style={{ margin: 0 }}>Counts only. No names, messages or table titles reach this page.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
        {LABELS.map(([key, label]) => (
          <div key={key} className="panel" style={{ padding: "14px 16px", gap: 4 }} data-count={key}>
            <div style={{ fontSize: 24, fontWeight: 600 }}>{counts[key] ?? "none yet"}</div>
            <div className="note" style={{ fontSize: 13 }}>{label}</div>
          </div>
        ))}
      </div>
      <h2 style={{ margin: "12px 0 0", fontSize: 18 }}>Bug reports</h2>
      {bugError && <p className="error" style={{ margin: 0 }}>Bug reports could not be read just now.</p>}
      {!bugError && bugs.length === 0 && <p className="note" style={{ margin: 0 }}>None yet.</p>}
      {bugs.map((b) => (
        <div key={b.id} className="panel" style={{ padding: "12px 16px", gap: 6, maxWidth: "none" }} data-bug={b.id}>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 15, lineHeight: 1.5 }}>{b.body}</div>
          <div className="note" style={{ fontSize: 12 }}>{new Date(b.at).toISOString().slice(0, 16).replace("T", " ")} UTC · on {b.place || "unknown"} · {b.browser.slice(0, 90)}</div>
        </div>
      ))}
    </main>
  );
}
