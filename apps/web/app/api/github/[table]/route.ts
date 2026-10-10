// GitHub's webhook for one table. The body goes to the database exactly as GitHub sent it, with GitHub's signature;
// the database checks the signature against the table's secret before anything is posted. No session, no code kept.

const MAX = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function POST(req: Request, { params }: { params: Promise<{ table: string }> }) {
  const { table } = await params;
  if (!UUID.test(table)) return new Response(null, { status: 404 });
  const payload = await req.text();
  if (payload.length > MAX) return new Response(null, { status: 413 });
  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/github_event`, {
    method: "POST",
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({
      t: table,
      signature: req.headers.get("x-hub-signature-256"),
      event: req.headers.get("x-github-event"),
      payload,
    }),
  });
  if (!res.ok) return new Response(null, { status: 502 });
  const outcome = (await res.json()) as string;
  return new Response(null, { status: outcome === "refused" ? 401 : 204 });
}
