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
        me={{ id: mine.id, display_name: mine.display_name }}
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
    supabase.from("chats").select("id, name, about, is_general, created_at").eq("table_id", id).order("created_at"),
    supabase.from("messages").select(MESSAGE_COLUMNS).eq("table_id", id).order("created_at", { ascending: false }).limit(300),
    supabase.from("decisions").select(DECISION_COLUMNS).eq("table_id", id).order("created_at", { ascending: false }).limit(100),
    supabase.from("jobs").select(JOB_COLUMNS).eq("table_id", id).in("status", ["queued", "running", "waiting", "failed"]).order("created_at", { ascending: false }).limit(50),
    supabase.from("connections").select(CONNECTION_COLUMNS).eq("table_id", id).is("revoked_at", null),
    supabase.from("notes").select(NOTE_COLUMNS).eq("table_id", id),
    supabase.from("requests").select(REQUEST_COLUMNS).eq("table_id", id).order("created_at", { ascending: false }).limit(200),
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
      initialNotes={(notes ?? []) as Note[]}
      initialRequests={(requests ?? []) as Request[]}
      initialChatId={start?.id ?? ""}
    />
  );
}
