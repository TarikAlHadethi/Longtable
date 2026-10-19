// Talking to Longtable. The connection has no login: it uses the public key and proves itself with its device token,
// and the only things it can call are the pairing and runner functions.

export async function fetchConfig(app) {
  const res = await fetch(new URL("/api/connect/config", app));
  if (!res.ok) throw new Error(`Longtable at ${app} did not answer (${res.status})`);
  return res.json();
}

export function client({ supabaseUrl, publishableKey }) {
  // Where Longtable's own storage is, so an attachment is only ever fetched from there.
  rpc.base = supabaseUrl;
  // And the public key, so a helper it starts (the approval server of a full Claude Code run) can reach Longtable too.
  rpc.key = publishableKey;
  return rpc;
  async function rpc(fn, args) {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) throw new Error(body?.message || `Longtable said no (${res.status})`);
    return body;
  }
}
