import { notFound, redirect } from "next/navigation";
import { serverClient } from "@/lib/supabase/server";
import { ClientPage } from "./client-page";
import { Room } from "./room";
import {
  CONNECTION_COLUMNS, DECISION_COLUMNS, EVENT_COLUMNS, JOB_COLUMNS, LINE_COLUMNS, MESSAGE_COLUMNS, NOTE_COLUMNS, REQUEST_COLUMNS, UPDATE_COLUMNS,
  type Chat, type ClientLine, type ClientUpdate, type Connection, type Decision, type Job, type Member, type Message, type Note, type Request,
  type RequestEvent,
} from "./types";

type MemberRow = Member & { user_id: string };

export type RoomView = "table" | "chat" | "logs" | "settings";

// The room, opened on the table, a chat, the logs or the settings. Each of those has its own address, and all of them
// are this one page: moving between them inside the room never goes back to the server.
export async function RoomPage({ id, wanted, view, side }: { id: string; wanted?: string | string[]; view?: "logs" | "settings"; side?: boolean }) {
  const supabase = await serverClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/sign-in?next=/t/${id}${view === "settings" ? "/settings" : view === "logs" ? "/activity" : ""}`);

  const { data: table } = await supabase.from("tables").select("id, name").eq("id", id).maybeSingle();
  if (!table) notFound();

  const { data: rows } = await supabase
    .from("members")
    .select("id, user_id, display_name, role, color, created_at, avatar, name_color, status, bubble")
    .eq("table_id", id)
    .is("removed_at", null)
    .order("created_at");
  const members = (rows ?? []) as MemberRow[];
  const mine = members.find((m) => m.user_id === user.id);
  if (!mine) notFound();

  // The client gets their own page: what they asked for and what they were told, never the team side.
  if (mine.role === "client") {
    const [{ data: requests }, { data: events }, { data: updates }, { data: lines }, { data: connections }, { data: jobs }] = await Promise.all([
      supabase.from("requests").select(REQUEST_COLUMNS).eq("table_id", id).eq("member_id", mine.id),
      supabase.from("request_events").select(EVENT_COLUMNS).eq("table_id", id),
      supabase.from("client_updates").select(UPDATE_COLUMNS).eq("table_id", id).order("created_at"),
      supabase.from("client_lines").select(LINE_COLUMNS).eq("table_id", id).eq("member_id", mine.id).order("created_at").limit(200),
      supabase.from("connections").select(CONNECTION_COLUMNS).eq("table_id", id).eq("member_id", mine.id).is("revoked_at", null),
      supabase.from("jobs").select(JOB_COLUMNS).eq("table_id", id).eq("member_id", mine.id).in("status", ["queued", "running"]),
    ]);
    return (
      <ClientPage
        table={table}
        me={{ id: mine.id, display_name: mine.display_name, color: mine.color }}
        initialRequests={(requests ?? []) as Request[]}
        initialEvents={(events ?? []) as RequestEvent[]}
        initialUpdates={(updates ?? []) as ClientUpdate[]}
        initialLines={(lines ?? []) as ClientLine[]}
        initialConnections={(connections ?? []) as Connection[]}
        initialJobs={(jobs ?? []) as Job[]}
      />
    );
  }

  const [{ data: chats }, { data: recent }, { data: decisions }, { data: jobs }, { data: connections }, { data: notes }, { data: requests }] = await Promise.all([
    supabase.from("chats").select("id, name, about, is_general, created_at, created_by").eq("table_id", id).order("created_at"),
    supabase.from("messages").select(MESSAGE_COLUMNS).eq("table_id", id).order("created_at", { ascending: false }).limit(300),
    supabase.from("decisions").select(DECISION_COLUMNS).eq("table_id", id).order("created_at", { ascending: false }).limit(100),
    supabase.from("jobs").select(JOB_COLUMNS).eq("table_id", id).in("status", ["queued", "running", "waiting", "failed"]).order("created_at", { ascending: false }).limit(50),
    supabase.from("connections").select(CONNECTION_COLUMNS).eq("table_id", id).order("created_at", { ascending: false }).limit(60),
    supabase.from("notes").select(NOTE_COLUMNS).eq("table_id", id),
    supabase.from("requests").select(REQUEST_COLUMNS).eq("table_id", id).order("created_at", { ascending: false }).limit(200),
  ]);
  const { data: tableAi } = await supabase.from("table_ai").select("model").eq("table_id", id).maybeSingle();
  const chatList = (chats ?? []) as Chat[];
  const general = chatList.find((c) => c.is_general) ?? chatList[0];
  // No chat asked for: the room opens on the table itself. "?c=general" is a short way to ask for the first chat.
  const want = Array.isArray(wanted) ? wanted[0] : wanted;
  const start = chatList.find((c) => c.id === want) ?? general;

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
      initialNotes={(notes ?? []) as Note[]}
      initialRequests={(requests ?? []) as Request[]}
      initialChatId={start?.id ?? ""}
      initialView={view === "settings" ? (mine.role === "owner" ? "settings" : "logs") : view ?? (side ? "client" : want ? "chat" : "table")}
      initialTableModel={(tableAi as { model: string | null } | null)?.model ?? null}
    />
  );
}
