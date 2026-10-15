// Does a client's copy open for someone who is not signed in to the hosting? The owner asks; this looks, from the
// server, and notes what it found. It only ever opens the address already kept for that copy.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { serverClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Never a machine on a private network, whatever address was typed. Names are judged whole: "10.preview.example.com"
// and "app.localstack.cloud" are public names, which the old unanchored rule refused. A typed number is judged by
// the rule for addresses below, like every address a name leads to.
const PRIVATE_NAME = /^(localhost|.+\.local|.+\.internal|.+\.localhost)$/i;
// Nor a public name that leads to one: the name is looked up first, and every address it has must be a public one.
const PRIVATE_ADDRESS = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|::$|::1$|::ffff:|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;

export async function POST(req: Request) {
  const { member } = ((await req.json().catch(() => null)) ?? {}) as { member?: string };
  if (!member || !UUID.test(member)) return Response.json({ ok: false, why: "bad" }, { status: 400 });
  const supabase = await serverClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ ok: false, why: "signed-out" }, { status: 401 });
  // Only the team can read this row at all.
  const { data: box } = await supabase.from("sandboxes").select("url, table_id").eq("member_id", member).maybeSingle();
  const url = (box as { url?: string | null } | null)?.url;
  if (!url) return Response.json({ ok: false, why: "no-address" }, { status: 404 });
  // The owner asks, nobody else: checked before the server goes anywhere, not only when the answer is noted.
  const { data: owner } = await supabase.rpc("is_owner", { t: (box as { table_id: string }).table_id });
  if (!owner) return Response.json({ ok: false, why: "not-owner" }, { status: 403 });

  let ok = false;
  let why = "unreachable";
  try {
    const at = new URL(url);
    // Only the usual https port: any other is how a public name is pointed at a service it was never meant to show.
    if (at.protocol !== "https:" || (at.port && at.port !== "443") || at.hostname.startsWith("[")) throw new Error("not public");
    if (!isIP(at.hostname) && (!at.hostname.includes(".") || PRIVATE_NAME.test(at.hostname))) throw new Error("not public");
    const leads = await lookup(at.hostname, { all: true });
    if (!leads.length || leads.some((a) => PRIVATE_ADDRESS.test(a.address))) throw new Error("not public");
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
