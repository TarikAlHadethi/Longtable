import { Arrow } from "@/components/icons";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Mark } from "@/components/mark";
import { serverClient } from "@/lib/supabase/server";
import { AuthShell } from "@/components/auth-shell";
import s from "@/components/auth.module.css";
import { StartChoices, type Wait } from "./start-choices";

type Row = { table_id: string; role: string; tables: { name: string } | null };

// Your tables, tables you are waiting to be let into, and starting or joining one.
export default async function Start({ searchParams }: { searchParams: Promise<Record<string, string | string[]>> }) {
  const q = await searchParams;
  const given = String((Array.isArray(q.code) ? q.code[0] : q.code) ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const supabase = await serverClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(given ? `/start?code=${given}` : q.join ? "/start?join=1" : "/start")}`);

  const [{ data, error }, { data: waitRows }] = await Promise.all([
    supabase
      .from("members")
      // Named by its key: tables point back at members too (whose AI speaks for the table), so the plain name is two ways.
      .select("table_id, role, tables!members_table_id_fkey(name)")
      .eq("user_id", user.id)
      .is("removed_at", null)
      .order("created_at", { ascending: false }),
    supabase.rpc("my_join_requests"),
  ]);
  // A read that failed is not "no tables": that showed someone with tables the page for starting their first one.
  if (error) throw new Error("Your tables could not be read just now.");
  const rows = (data ?? []) as unknown as Row[];
  const at = new Set(rows.map((r) => r.table_id));
  // A table they were let into already shows in the list above.
  const waits = ((waitRows ?? []) as Wait[]).filter((w) => !(w.status === "in" && at.has(w.table_id)));
  const new_ = rows.length === 0 && waits.length === 0;

  return (
    <AuthShell title={rows.length > 0 ? "Your tables" : new_ ? "Welcome to Longtable" : "Almost there"}
      lead={new_ ? "Start a table for your team, or join one that already exists."
        : rows.length === 0 ? "You'll move into the table the moment an owner lets you in." : undefined}>
      {rows.length > 0 && (
        <div className={s.tables}>
          {rows.map((r) => (
            <Link key={r.table_id} href={`/t/${r.table_id}`} className={s.table}>
              <span className={s.tableIcon}><Mark size={20} /></span>
              <span className={s.tableName}>{r.tables?.name ?? "A table"}</span>
              <span className={s.tableRole}>{r.role}</span>
              <span className={s.tableGo}><Arrow size={16} /></span>
            </Link>
          ))}
        </div>
      )}
      <StartChoices waits={waits} code={given} join={!!q.join} hasTables={rows.length > 0} />
    </AuthShell>
  );
}
