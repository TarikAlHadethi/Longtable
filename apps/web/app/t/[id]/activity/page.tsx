import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { serverClient } from "@/lib/supabase/server";
import { ActivityTime } from "./activity-time";

type Entry = { id: number; actor: string | null; action: string; details: Record<string, string | boolean>; created_at: string };

// Every action, in plain words, from the append-only log. Team only: the database refuses it to anyone else.
export default async function Activity({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await serverClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/sign-in?next=/t/${id}/activity`);

  const { data: table } = await supabase.from("tables").select("id, name").eq("id", id).maybeSingle();
  if (!table) notFound();
  const [{ data: rows }, { data: people }] = await Promise.all([
    supabase.from("activity").select("id, actor, action, details, created_at").eq("table_id", id).order("id", { ascending: false }).limit(300),
    supabase.from("members").select("id, display_name, role").eq("table_id", id),
  ]);
  const names = new Map((people ?? []).map((p: { id: string; display_name: string }) => [p.id, p.display_name]));
  const clientName = (people ?? []).find((p: { role: string }) => p.role === "client")?.display_name ?? "The client";
  const who = (e: Entry) => (e.actor ? names.get(e.actor) ?? "Someone" : "Longtable");

  function say(e: Entry) {
    const d = e.details ?? {};
    switch (e.action) {
      case "table.repo_set": return `${who(e)} ${d.set ? "said where the project's code is" : "removed the project's code address"}`;
      case "table.started": return `${who(e)} started the table "${d.name}"`;
      case "invite.created": return `${who(e)} made an invite link for ${d.role === "client" ? "the client" : "a developer"}`;
      case "member.joined": return `${d.name ?? who(e)} joined as ${d.role === "client" ? "the client" : "a developer"}`;
      case "chat.renamed": return `${who(e)} renamed the chat "${d.from}" to "${d.name}"`;
      case "chat.deleted": return `${who(e)} deleted the chat "${d.name}"`;
      case "chat.created": return `${who(e)} made the chat "${d.name}"`;
      case "decision.created": return `${who(e)} asked for a decision: ${d.title}`;
      case "decision.decided": return `${who(e)} decided "${d.title}": ${d.option}`;
      case "decision.undone": return `${who(e)} undid the decision "${d.title}"`;
      case "decision.delivered": return d.told_client ? `${clientName} was told the decision "${d.title}"` : `The decision "${d.title}" took effect`;
      default: return `${who(e)}: ${e.action}`;
    }
  }

  const entries = (rows ?? []) as Entry[];
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "40px 16px" }}>
      <Link href={`/t/${id}`} style={{ fontSize: 14 }}>Back to {table.name}</Link>
      <h1 style={{ fontSize: 24, letterSpacing: "-0.01em", margin: "12px 0 6px" }}>Activity</h1>
      <p className="note" style={{ marginTop: 0 }}>Everything that happened at this table. Nothing here can be edited or deleted.</p>
      {entries.length === 0 && <p className="note">Nothing yet.</p>}
      <ol style={{ listStyle: "none", padding: 0, margin: "20px 0 0", display: "flex", flexDirection: "column", gap: 2 }}>
        {entries.map((e) => (
          <li key={e.id} style={{ display: "flex", gap: 16, padding: "10px 12px", borderRadius: 10, background: "var(--card)", border: "1px solid var(--line)" }}>
            <ActivityTime iso={e.created_at} />
            <span style={{ fontSize: 14, lineHeight: 1.5 }}>{say(e)}</span>
          </li>
        ))}
      </ol>
    </main>
  );
}
