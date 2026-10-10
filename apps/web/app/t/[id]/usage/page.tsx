import { notFound, redirect } from "next/navigation";
import { serverClient } from "@/lib/supabase/server";
import { UsageView, type Card } from "./usage-view";

type Limits = { ai?: string; plan?: string | null; status?: string; windows?: { name: string; used: number; resets: string | null }[] };

// Usage, for the team: each person's AI on their own plan, its limits as their AI last reported them, and what it
// did at this table in the last seven days.
export default async function Usage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await serverClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/sign-in?next=/t/${id}/usage`);
  const { data: table } = await supabase.from("tables").select("id, name").eq("id", id).maybeSingle();
  if (!table) notFound();
  const { data: people } = await supabase.from("members").select("id, user_id, display_name, role, color")
    .eq("table_id", id).is("removed_at", null).order("created_at");
  const mine = (people ?? []).find((m) => m.user_id === user.id);
  if (!mine) notFound();
  if (mine.role === "client") redirect(`/t/${id}`);

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const [{ data: connections }, { data: jobs }] = await Promise.all([
    supabase.from("connections").select("member_id, kind, last_seen, limits, limits_at").eq("table_id", id).is("revoked_at", null),
    supabase.from("jobs").select("member_id, status, usage").eq("table_id", id).gte("created_at", since),
  ]);

  const cards: Card[] = (people ?? []).map((p) => {
    const mineConns = (connections ?? []).filter((c) => c.member_id === p.id);
    const latest = [...mineConns].sort((a, b) => (b.limits_at ?? "").localeCompare(a.limits_at ?? ""))[0];
    const done = (jobs ?? []).filter((j) => j.member_id === p.id && j.status === "done");
    const tokens = done.reduce((n, j) => n + ((j.usage as { input?: number })?.input ?? 0) + ((j.usage as { output?: number })?.output ?? 0), 0);
    return {
      id: p.id,
      name: p.display_name,
      role: p.role,
      color: p.color,
      ai: mineConns.map((c) => (c.kind === "codex" ? "Codex" : "Claude")),
      lastSeen: mineConns.map((c) => c.last_seen).filter(Boolean).sort().at(-1) ?? null,
      limits: (latest?.limits ?? null) as Limits | null,
      limitsAt: latest?.limits_at ?? null,
      jobs: done.length,
      tokens,
    };
  });

  return <UsageView table={table} cards={cards} />;
}
