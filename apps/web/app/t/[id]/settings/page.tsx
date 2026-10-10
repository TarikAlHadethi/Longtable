import { notFound, redirect } from "next/navigation";
import { serverClient } from "@/lib/supabase/server";
import { SettingsForm } from "./settings-form";

// The owner's settings. Everyone else is sent back to the table.
export default async function Settings({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await serverClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/sign-in?next=/t/${id}/settings`);

  const { data: table } = await supabase.from("tables")
    .select("id, name, undo_seconds, client_chat, final_seat, when_final_offline").eq("id", id).maybeSingle();
  if (!table) notFound();
  const { data: people } = await supabase.from("members")
    .select("id, user_id, display_name, role, color").eq("table_id", id).is("removed_at", null).order("created_at");
  const mine = (people ?? []).find((m) => m.user_id === user.id);
  if (!mine) notFound();
  if (mine.role !== "owner") redirect(`/t/${id}`);
  const { data: chats } = await supabase.from("chats").select("id, name, is_general").eq("table_id", id).order("created_at");

  return (
    <SettingsForm
      table={table}
      me={mine.id}
      people={(people ?? []).map(({ user_id: _u, ...p }) => p)}
      chats={chats ?? []}
    />
  );
}
