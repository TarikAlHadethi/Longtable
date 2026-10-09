import Link from "next/link";
import { redirect } from "next/navigation";
import { Mark } from "@/components/mark";
import { serverClient } from "@/lib/supabase/server";
import { StartForm } from "./start-form";

type Row = { table_id: string; role: string; tables: { name: string } | null };

// Your tables, and starting a new one.
export default async function Start() {
  const supabase = await serverClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in?next=/start");

  const { data } = await supabase
    .from("members")
    .select("table_id, role, tables(name)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  const rows = (data ?? []) as unknown as Row[];

  return (
    <main className="page-center">
      <div className="panel">
        <Mark size={40} />
        {rows.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h1>Your tables</h1>
            {rows.map((r) => (
              <Link key={r.table_id} href={`/t/${r.table_id}`} className="btn btn-quiet" style={{ justifyContent: "space-between" }}>
                <span>{r.tables?.name ?? "A table"}</span>
                <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 500 }}>{r.role}</span>
              </Link>
            ))}
          </div>
        )}
        <h1>{rows.length > 0 ? "Start another table" : "Start a table"}</h1>
        <StartForm />
      </div>
    </main>
  );
}
