// A page on the server tells "signed out" apart from "the sign-in service could not be reached for a moment": only the
// first sends someone to sign in. No database, no AI.
//
//   node tests/e2e/unit-signed-in.mjs

const { signedInUser, signedInOrNull } = await import("../../apps/web/lib/signed-in.mjs");
const { AuthRetryableFetchError, AuthSessionMissingError, AuthApiError } = await import("@supabase/supabase-js");
let failed = 0;
const check = (name, ok, got) => { console.log(`${ok ? "pass" : "FAIL"}  ${name}`); if (!ok) { failed++; if (got !== undefined) console.log("      got:", got); } };

// A stand-in client whose getUser answers from a list, one answer per call.
const client = (...answers) => {
  const c = { calls: 0, auth: { getUser: async () => answers[Math.min(c.calls++, answers.length - 1)] } };
  return c;
};
const user = { id: "u1" };
const ok = { data: { user }, error: null };
const missing = { data: { user: null }, error: new AuthSessionMissingError() };
const ended = { data: { user: null }, error: new AuthApiError("Session not found", 403, "session_not_found") };
const down = { data: { user: null }, error: new AuthRetryableFetchError("fetch failed", 0) };
const busy = { data: { user: null }, error: new AuthRetryableFetchError("Service Unavailable", 503) };
const fast = { pause: 1 };

{
  const c = client(ok);
  check("a good sign-in is the person", (await signedInUser(c, fast)) === user);
  check("asked once", c.calls === 1, c.calls);
}
{
  const c = client(missing);
  check("no sign-in at all is signed out", (await signedInUser(c, fast)) === null);
  check("and is not asked again", c.calls === 1, c.calls);
}
check("a sign-in the server ended is signed out", (await signedInUser(client(ended), fast)) === null);
{
  const c = client(down, ok);
  check("a moment the service cannot be reached is tried again, and the person is still signed in", (await signedInUser(c, fast)) === user);
  check("tried twice", c.calls === 2, c.calls);
}
check("a busy service is tried again too", (await signedInUser(client(busy, ok), fast)) === user);
{
  const c = client(down, down, down);
  let threw = null;
  try { await signedInUser(c, fast); } catch (e) { threw = e; }
  check("still unreachable: a fault, never a sign-out", threw instanceof Error, threw);
  check("and it stops after two tries", c.calls === 2, c.calls);
}
check("where only the look changes, a fault shows as signed out", (await signedInOrNull(client(down, down))) === null);
check("and a good sign-in still shows", (await signedInOrNull(client(ok))) === user);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
