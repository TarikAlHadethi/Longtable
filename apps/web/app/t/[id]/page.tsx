import { notFound, redirect } from "next/navigation";
import { Mark } from "@/components/mark";
import { serverClient } from "@/lib/supabase/server";
import { Room } from "./room";
import { CONNECTION_COLUMNS, DECISION_COLUMNS, JOB_COLUMNS, MESSAGE_COLUMNS, type Chat, type Connection, type Decision, type Job, type Member, type Message } from "./types";

type MemberRow = Member & { user_id: string };

export default async function TablePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const { id } = await params;
  const wanted = (await searchParams).c;
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

  const [{ data: chats }, { data: recent }, { data: decisions }, { data: jobs }, { data: connections }] = await Promise.all([
    supabase.from("chats").select("id, name, about, is_general, created_at").eq("table_id", id).order("created_at"),
    supabase.from("messages").select(MESSAGE_COLUMNS).eq("table_id", id).order("created_at", { ascending: false }).limit(300),
    supabase.from("decisions").select(DECISION_COLUMNS).eq("table_id", id).order("created_at", { ascending: false }).limit(100),
    supabase.from("jobs").select(JOB_COLUMNS).eq("table_id", id).in("status", ["queued", "running", "failed"]).order("created_at", { ascending: false }).limit(50),
    supabase.from("connections").select(CONNECTION_COLUMNS).eq("table_id", id).is("revoked_at", null),
  ]);
  const chatList = (chats ?? []) as Chat[];
  const general = chatList.find((c) => c.is_general) ?? chatList[0];
  const start = chatList.find((c) => c.id === (Array.isArray(wanted) ? wanted[0] : wanted)) ?? general;

  const strip = ({ user_id: _u, ...m }: MemberRow): Member => m;
  return (
    <Room
      table={table}
      me={strip(mine)}
      initialMembers={members.map(strip)}
      initialChats={chatList}
      initialMessages={((recent ?? []) as Message[]).reverse()}
      initialDecisions={(decisions ?? []) as unknown as Decision[]}
      initialJobs={(jobs ?? []) as Job[]}
      initialConnections={(connections ?? []) as Connection[]}
      initialChatId={start?.id ?? ""}
    />
  );
}
