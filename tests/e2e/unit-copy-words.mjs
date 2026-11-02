// A client's line that became a change in their copy shows once, in their own words, and stops the thinking line, even
// though the team's assistant wrote the change out in its own words. No database, no AI.
//
//   node tests/e2e/unit-copy-words.mjs

const { copyWords } = await import("../../apps/web/lib/copy-words.mjs");
let failed = 0;
const check = (name, ok, got) => { console.log(`${ok ? "pass" : "FAIL"}  ${name}`); if (!ok) { failed++; if (got !== undefined) console.log("      got:", JSON.stringify(got)); } };

const at = (seconds) => new Date(Date.UTC(2026, 10, 2, 13, 0, seconds)).toISOString();
const said = (id, seconds, body, over = {}) => ({ id, who: "client", by_table: true, body, created_at: at(seconds), ...over });
const reply = (id, seconds) => ({ id, who: "ai", by_table: true, body: "An answer", created_at: at(seconds) });
const change = (id, seconds) => ({ id, created_at: at(seconds) });

{
  const r = copyWords([said("a", 0, "make the Sign in button say Log in")], [change("c", 6)]);
  check("a change the assistant reworded belongs to the line it heard", r.lineIds.has("a"), [...r.lineIds]);
  check("and the change shows the client's own words", r.saidFor.get("c") === "make the Sign in button say Log in", r.saidFor.get("c"));
}
{
  const r = copyWords([said("q", 0, "is that possible?"), reply("r", 5), said("y", 20, "yes do it")], [change("c", 26)]);
  check("a yes to an offer is the line the change carries", r.saidFor.get("c") === "yes do it" && r.lineIds.has("y"), r.saidFor.get("c"));
  check("the question before it stays a line", !r.lineIds.has("q"));
}
{
  const r = copyWords([said("a", 0, "where are we?"), reply("r", 5)], [change("c", 30)]);
  check("a line already answered is not taken by a later change", r.lineIds.size === 0 && !r.saidFor.has("c"), [...r.lineIds]);
}
{
  const r = copyWords([said("a", 0, "change the title"), said("b", 3, "how far along is it?")], [change("c", 6)]);
  check("only the newest line before the change is carried", r.lineIds.has("b") && !r.lineIds.has("a"), [...r.lineIds]);
}
{
  const r = copyWords([said("a", 0, "change the title", { by_table: false })], [change("c", 6)]);
  check("a line to the client's own assistant is left alone", r.lineIds.size === 0);
}
{
  const r = copyWords([said("a", 0, "change the title")], [{ id: "c", created_at: new Date(Date.UTC(2026, 10, 2, 13, 11, 0)).toISOString() }]);
  check("a change much later is not tied to an old line", r.lineIds.size === 0);
}
{
  const r = copyWords([said("a", 1, "make it blue")], [change("c", 0)]);
  check("a change stamped a moment before its line still belongs to it", r.lineIds.has("a"));
}
check("no lines and no changes is fine", copyWords([], []).lineIds.size === 0);

console.log(`\n${failed ? `${failed} failed` : "all passed"}`);
process.exit(failed ? 1 : 0);
