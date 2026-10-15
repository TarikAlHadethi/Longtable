// GitHub's webhook for one table. The body goes to the database exactly as GitHub sent it, with GitHub's signature;
// the database checks the signature against the table's secret before anything is posted. No session, no code kept.

const MAX = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNED = /^sha256=[0-9a-f]{64}$/;

export async function POST(req: Request, { params }: { params: Promise<{ table: string }> }) {
  const { table } = await params;
  if (!UUID.test(table)) return new Response(null, { status: 404 });
  // Nothing without GitHub's signature reaches the database; and a body said to be too big is not read at all.
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  if (!SIGNED.test(signature)) return new Response(null, { status: 401 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX) return new Response(null, { status: 413 });
  const payload = await req.text();
  if (payload.length > MAX) return new Response(null, { status: 413 });
  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/github_event`, {
    method: "POST",
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({
      t: table,
      signature,
      event: req.headers.get("x-github-event"),
      payload,
      delivery: req.headers.get("x-github-delivery"),
    }),
  });
  if (!res.ok) return new Response(null, { status: 502 });
  // A reply that is not the expected one is the database's fault, said as such, not a crash of this route.
  const outcome = (await res.json().catch(() => null)) as string | null;
  if (typeof outcome !== "string") return new Response(null, { status: 502 });
  return new Response(null, { status: outcome === "refused" ? 401 : 204 });
}
