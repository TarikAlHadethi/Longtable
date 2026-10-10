"use client";

import { browserClient } from "@/lib/supabase/browser";

// Download a table's record (owner, export_table) or your own (anyone, export_mine) as a JSON file, built in the
// browser from what the database returns. Returns an error message, or "" when it worked.
export async function downloadExport(fn: "export_table" | "export_mine", tableId: string, name: string) {
  const { data, error } = await browserClient().rpc(fn, { t: tableId });
  if (error || !data) return error?.message ?? "That did not work. Try again.";
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^\w.-]+/g, "-").toLowerCase()}-${fn === "export_table" ? "table" : "mine"}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return "";
}
