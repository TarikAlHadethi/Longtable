// Runs one eval case through the connection's own job path: the same task, fence, system prompt, schema and locked
// down Claude Code as production. Team cases read this repo (read-only, restricted to it); client cases get an empty
// folder and no tools. Prints one JSON line: the structured answer, refused tool calls, and the folder's git state.
//
//   node tests/evals/run_case.mjs '<case json>'
// Uses ANTHROPIC_API_KEY when set (CI, the owner's key), otherwise this computer's saved Claude sign-in.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ask, findClaude } from "../../packages/connect/src/claude.mjs";
import { KINDS, buildPrompt, systemFor } from "../../packages/connect/src/run.mjs";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const job = JSON.parse(process.argv[2]);
const client = job.kind === "client";
const cwd = client ? mkdtempSync(join(tmpdir(), "longtable-eval-")) : repo;
const status = () => (client ? "" : execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }));
const before = status();

const result = await ask({
  claude: findClaude(),
  cwd,
  prompt: buildPrompt(job),
  system: systemFor(job),
  schema: KINDS[job.kind].schema,
  tools: client ? "" : "Read,Grep,Glob",
  model: process.env.LONGTABLE_MODEL || "haiku",
  apiKey: process.env.ANTHROPIC_API_KEY || undefined,
});

process.stdout.write(JSON.stringify({
  structured: result.structured_output ?? null,
  is_error: !!result.is_error,
  refused: (result.permission_denials || []).map((d) => d.tool_name),
  changed: status() !== before,
}) + "\n");
