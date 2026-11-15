import type { SupabaseClient } from "@supabase/supabase-js";
import { CHANGE_COLUMNS, CHAT_COLUMNS, CONNECTION_COLUMNS, DECISION_COLUMNS, JOB_COLUMNS, MESSAGE_COLUMNS, REQUEST_COLUMNS, SANDBOX_COLUMNS, TASK_COLUMNS } from "./types";

// The table's reads, defined once for the room's first load (on the server) and its catch-up (in the browser), so the
// two never read a different slice of the same thing.
export const tableReads = (supabase: SupabaseClient, t: string) => ({
  chats: () => supabase.from("chats").select(CHAT_COLUMNS).eq("table_id", t).order("created_at"),
  messages: (newest: number) => supabase.from("messages").select(MESSAGE_COLUMNS).eq("table_id", t).order("created_at", { ascending: false }).limit(newest),
  decisions: () => supabase.from("decisions").select(DECISION_COLUMNS).eq("table_id", t).order("created_at", { ascending: false }).limit(100),
  jobs: () => supabase.from("jobs").select(JOB_COLUMNS).eq("table_id", t).in("status", ["queued", "running", "waiting", "failed"]).order("created_at", { ascending: false }).limit(50),
  connections: () => supabase.from("connections").select(CONNECTION_COLUMNS).eq("table_id", t).order("created_at", { ascending: false }).limit(60),
  requests: () => supabase.from("requests").select(REQUEST_COLUMNS).eq("table_id", t).order("created_at", { ascending: false }).limit(200),
  sandboxes: () => supabase.from("sandboxes").select(SANDBOX_COLUMNS).eq("table_id", t),
  changes: () => supabase.from("sandbox_changes").select(CHANGE_COLUMNS).eq("table_id", t).order("created_at", { ascending: false }).limit(120),
  tasks: () => supabase.from("tasks").select(TASK_COLUMNS).eq("table_id", t).order("created_at", { ascending: false }).limit(40),
});
