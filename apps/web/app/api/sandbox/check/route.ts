// Does a client's copy open for someone who is not signed in to the hosting? The owner asks; this looks, from the
// server, and notes what it found. It only ever opens the address already kept for that copy.

import { serverClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Never a machine on a private network, whatever address was typed.
const PRIVATE = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i;

export async function POST(req: Request) {
  const { member } = (await req.json().catch(() => ({}))) as { member?: string };
  if (!member || !UUID.test(member)) return Response.json({ ok: false, why: "bad" }, { status: 400 });
  const supabase = await serverClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ ok: false, why: "signed-out" }, { status: 401 });
  // Only the team can read this row at all.
  const { data: box } = await supabase.from("sandboxes").select("url").eq("member_id", member).maybeSingle();
  const url = (box as { url?: string | null } | null)?.url;
  if (!url) return Response.json({ ok: false, why: "no-address" }, { status: 404 });

  let ok = false;
  let why = "unreachable";
  try {
    const at = new URL(url);
    if (at.protocol !== "https:" || !at.hostname.includes(".") || PRIVATE.test(at.hostname)) throw new Error("not public");
    const res = await fetch(at, { redirect: "manual", signal: AbortSignal.timeout(9000), headers: { "user-agent": "Longtable copy check" } });
    const to = res.headers.get("location") ?? "";
    if (res.status === 401 || res.status === 403 || /\/(login|sso|signin|sign-in|auth)\b/i.test(to) || /vercel\.com|netlify\.com\/|cloudflareaccess\.com/i.test(to)) why = "sign-in";
    else if (res.status >= 500) why = "broken";
    else if (res.status === 404) why = "not-up";
    else { ok = true; why = "open"; }
  } catch {
    // Left as unreachable.
  }
  const { error } = await supabase.rpc("note_sandbox_open", { m: member, ok });
  if (error) return Response.json({ ok: false, why: "not-owner" }, { status: 403 });
  return Response.json({ ok, why });
}
