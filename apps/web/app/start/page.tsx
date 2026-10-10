import Link from "next/link";
import { redirect } from "next/navigation";
import { Mark } from "@/components/mark";
import { serverClient } from "@/lib/supabase/server";
import { AuthShell } from "@/components/auth-shell";
import s from "@/components/auth.module.css";
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
    <AuthShell title={rows.length > 0 ? "Your tables" : "Start a table"}
      lead={rows.length > 0 ? "Pick up where you left off, or start another." : "Name what you are working on. You can invite your team and your client next."}>
      {rows.length > 0 && (
        <>
          <div className={s.tables}>
            {rows.map((r) => (
              <Link key={r.table_id} href={`/t/${r.table_id}`} className={s.table}>
                <span className={s.tableIcon}><Mark size={20} /></span>
                <span className={s.tableName}>{r.tables?.name ?? "A table"}</span>
                <span className={s.tableRole}>{r.role}</span>
                <span className={s.tableGo}>→</span>
              </Link>
            ))}
          </div>
          <div className={s.or}>Start another table</div>
        </>
      )}
      <StartForm />
    </AuthShell>
  );
}
