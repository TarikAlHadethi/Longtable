// No connection is published with client-facing words the hard probe has not passed. The fingerprint is of what the
// models are actually handed (every client prompt, system and schema for each kind of job) plus the rulebook's own
// checks, so a change anywhere that reaches a client's answer needs `node tests/e2e/probe-client.mjs` to pass again.
// Run by `npm publish` in packages/connect (prepublishOnly), and by the probe itself to record a pass.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PASS_FILE = join(root, "tmp", "probe-client-pass.json");

export async function clientFingerprint() {
  const { clientLookPrompt, clientPrompt, clientSchema, sandboxSystem, systemFor } = await import("../packages/connect/src/run.mjs");
  const { clientFields } = await import("../packages/connect/src/client-rules.mjs");
  const base = { kind: "client", table_name: "T", me: "C", question: "Q", requests: [{ title: "R", status: "asked", timeline: ["You asked"] }],
    told: [{ words: "W" }], work: [{ title: "K", status: "done" }], history: [{ who: "client", body: "H" }] };
  const shapes = [{}, { for_team: true }, { for_team: true, can_look: true }, { for_team: true, can_look: true, has_copy: true },
    { for_team: true, has_copy: true }, { for_team: true, can_look: true, has_copy: true, already_passed: true },
    { for_team: true, can_look: true, has_copy: true, team_talking: true, history: [{ who: "team", name: "N", body: "H" }] }].map((o) => ({ ...base, ...o }));
  const parts = shapes.flatMap((j) => [clientPrompt(j), systemFor(j), JSON.stringify(clientSchema(j)), clientLookPrompt({ ...j, stage: 1, brief: "B" }),
    JSON.stringify(clientFields(j, { look: true }))]);
  parts.push(sandboxSystem({ client: "C", table_name: "T" }));
  parts.push(readFileSync(join(root, "packages/connect/src/client-rules.mjs"), "utf8"));
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  const now = await clientFingerprint();
  const last = existsSync(PASS_FILE) ? JSON.parse(readFileSync(PASS_FILE, "utf8")) : null;
  if (last?.fingerprint === now) {
    console.log(`client probe passed on these exact words (${last.runs} cases, ${last.at})`);
  } else {
    console.error(last
      ? "Stopped: what a client's assistant is told changed since the hard probe last passed."
      : "Stopped: the hard probe of the client's assistant has not passed on this computer yet.");
    console.error("Run it first (a few minutes, real model):  node tests/e2e/probe-client.mjs");
    process.exit(1);
  }
}
