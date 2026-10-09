import { notFound, redirect } from "next/navigation";
import { Mark } from "@/components/mark";
import { serverClient } from "@/lib/supabase/server";
import { Room, type Member, type Message } from "./room";

type MemberRow = Member & { user_id: string };

export default async function TablePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await serverClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/sign-in?next=/t/${id}`);

  const { data: table } = await supabase.from("tables").select("id, name").eq("id", id).maybeSingle();
  if (!table) notFound();

  const { data: rows } = await supabase
    .from("members")
    .select("id, user_id, display_name, role, color")
    .eq("table_id", id)
    .order("created_at");
  const members = (rows ?? []) as MemberRow[];
  const mine = members.find((m) => m.user_id === user.id);
  if (!mine) notFound();

  if (mine.role === "client") {
    return (
      <main className="page-center">
        <div className="panel" style={{ alignItems: "center", textAlign: "center" }}>
          <Mark size={48} />
          <h1>{table.name}</h1>
          <p className="note" style={{ margin: 0 }}>Your client page is being built. You'll be able to send requests and see decisions here.</p>
        </div>
      </main>
    );
  }

  const { data: recent } = await supabase
    .from("messages")
    .select("id, member_id, body, created_at")
    .eq("table_id", id)
    .order("created_at", { ascending: false })
    .limit(100);

  const strip = ({ user_id: _u, ...m }: MemberRow): Member => m;
  return (
    <Room
      table={table}
      me={strip(mine)}
      initialMembers={members.map(strip)}
      initialMessages={((recent ?? []) as Message[]).reverse()}
    />
  );
}
