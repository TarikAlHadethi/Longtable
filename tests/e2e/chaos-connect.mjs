// The connection under chaos: what must always be true of it (sweep-notes/rules.md, the P and B rules), checked
// over many random inputs from a seeded generator, with no AI, no network and no table. A failure prints its seed,
// the rule it broke and the input cut down to the fewest pieces that still break it, so it can be played again:
//
//   node tests/e2e/chaos-connect.mjs                  the fast set: fixed seeds, a few seconds
//   CHAOS_FULL=1 node tests/e2e/chaos-connect.mjs     the full set: many more seeds and inputs
//   CHAOS_SEED=17 node tests/e2e/chaos-connect.mjs    one seed again

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

// Every place the connection reads or writes on its own is pointed into a scratch folder before it is loaded, so the
// real ~/.longtable and ~/.claude of whoever runs this are never touched.
const scratch = mkdtempSync(join(tmpdir(), "longtable-chaos-"));
for (const k of ["USERPROFILE", "HOME"]) process.env[k] = join(scratch, "user");
process.env.LONGTABLE_HOME = join(scratch, "home");
process.env.LONGTABLE_CLAUDE_HOME = join(scratch, "claude");
mkdirSync(process.env.LONGTABLE_HOME, { recursive: true });
mkdirSync(join(scratch, "user"), { recursive: true });
const run = await import("../../packages/connect/src/run.mjs");
const { hideSecrets } = await import("../../packages/connect/src/store.mjs");
const { childEnv, lineReader } = await import("../../packages/connect/src/claude.mjs");
const { safeBranch, workBranch } = await import("../../packages/connect/src/repo.mjs");
const { layPointed, pointedPaths } = await import("../../packages/connect/src/pointed.mjs");
const { attachmentAddress, materialsPrompt, scanCommands, shareable } = await import("../../packages/connect/src/extras.mjs");

const FULL = !!process.env.CHAOS_FULL;
const SEEDS = process.env.CHAOS_SEED ? [Number(process.env.CHAOS_SEED)] : FULL ? Array.from({ length: 30 }, (_, i) => i + 1) : [1, 2, 3];
const NL = String.fromCharCode(10);

// ---- a small seeded generator, so every run with a seed is the same run
function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = { next, int: (n) => Math.floor(next() * n), pick: (xs) => xs[Math.floor(next() * xs.length)], chance: (p) => next() < p };
  r.list = (n, f) => Array.from({ length: r.int(n + 1) }, () => f());
  return r;
}
const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

// Pieces that hostile or merely odd text is made of.
const TOKENS = ["TABLE", "CODE", "YOURS", "PART", "SHARED", "COMMAND", "CLIENT"];
const atom = (r) => r.pick([
  () => `<<<${r.pick(TOKENS)}`, () => `${r.pick(TOKENS)}>>>`, () => r.pick(["<", "<<", ">", ">>", ">>>", "<<<"]),
  () => r.pick(["x", "_", "9", "é", "\u0000", " ", NL, "\r", "\t", "\"", "'", "`", "\\", "/", "@", ":", "%", "%E0%A4%A"]),
  () => r.pick(TOKENS), () => r.pick(TOKENS).toLowerCase(), () => "sk-ant-" + "a".repeat(r.int(14)),
  () => "f".repeat(r.pick([63, 64, 65])), () => "🙂", () => "\ud83d", () => "word", () => "x".repeat(r.int(3000)),
])();
const text = (r, n = 12) => r.list(n, () => atom(r));

// ---- properties: each is a name, the rule it holds, a generator of a list of pieces, and a test that returns ""
// when the rule holds or what went wrong when it does not.
const results = { checked: 0, broken: [] };
function shrink(input, test) {
  let cur = input;
  for (let changed = true; changed;) {
    changed = false;
    // The first piece is kept when it is a case's own settings ({ keep: true }): only what follows is cut down.
    for (let i = cur[0]?.keep ? 1 : 0; i < cur.length; i++) {
      const fewer = [...cur.slice(0, i), ...cur.slice(i + 1)];
      if (safe(test, fewer)) { cur = fewer; changed = true; break; }
    }
  }
  return cur;
}
function safe(test, input) { try { return test(input); } catch (e) { return `threw: ${e.message}`; } }
function prop(rule, name, n, gen, test) {
  for (const seed of SEEDS) {
    const r = rng(seed * 7919 + hash(name));
    for (let i = 0; i < (FULL ? n * 4 : n); i++) {
      const input = gen(r);
      results.checked++;
      const why = safe(test, input);
      if (why) {
        const small = Array.isArray(input) ? shrink(input, test) : input;
        results.broken.push({ rule, name, seed, step: i, why: String(safe(test, small) || why).slice(0, 300), input: JSON.stringify(small).slice(0, 600) });
        return;
      }
    }
  }
}
const count = (t, needle) => t.split(needle).length - 1;
const markers = (t) => [...TOKENS.map((k) => count(t, `<<<${k}`)), ...TOKENS.map((k) => count(t, `${k}>>>`))].join(",");

// P9, Q5: nothing cleaned keeps a marker, and cleaning twice is cleaning once.
prop("P9", "the fence cleaner leaves no marker and is steady", 300, (r) => text(r, 16), (parts) => {
  const once = run.inert(parts.join(""));
  if (/<<<(TABLE|CODE|YOURS|PART|SHARED|COMMAND|CLIENT)|(TABLE|CODE|YOURS|PART|SHARED|COMMAND|CLIENT)>>>/.test(once)) return `a marker survived: ${once.slice(0, 120)}`;
  return run.inert(once) === once ? "" : "cleaning twice changed it";
});

// P9: whatever the table says, a prompt has exactly the fences its own shape has. The same job with plain words in
// every field gives the counts the hostile one must match.
const KINDS = ["answer", "view", "work", "review", "combine", "plan", "look", "client"];
const jobOf = (r, say) => {
  const kind = r.pick(KINDS);
  const job = { kind, me: "Sam", table_name: "T", chat_name: "General", asker: "Maya", worker: r.chance(0.5) ? "Lee" : undefined, team: ["Lee"],
    question: say(), history: r.list(4, () => ({ name: "Lee", by_ai: r.chance(0.3), client: r.chance(0.2), body: say(), who: r.pick(["client", "ai"]) })),
    pinned: r.list(2, () => ({ title: "n", body: say() })), related: r.list(2, () => ({ chat: "c", name: "Lee", body: say() })),
    views: r.list(3, () => ({ name: "Lee", view: say(), meta: { part: r.pick(["work", "review", "plan", undefined]) } })),
    requests: r.list(2, () => ({ title: say(), status: "open", timeline: [say()] })), told: r.list(2, () => ({ words: say() })) };
  if (kind === "work" && r.chance(0.5)) job.brief = say();
  return job;
};
prop("P9", "a prompt has only the fences of its own shape", 200, (r) => {
  const pieces = [];
  const seedJob = r.int(1e9);
  return [{ keep: true, seedJob }, ...Array.from({ length: 30 }, () => { const p = text(r, 6).join(""); pieces.push(p); return p; })];
}, ([head, ...words]) => {
  if (!head) return "";
  const { seedJob } = head;
  let i = 0;
  // Never empty: an empty brief is no brief, which is a prompt of another shape, not an attack.
  const hostile = buildFrom(seedJob, () => "w " + (words[i++ % Math.max(1, words.length)] ?? ""));
  const plain = buildFrom(seedJob, () => "plain words");
  return markers(hostile) === markers(plain) ? "" : `hostile ${markers(hostile)} against ${markers(plain)}`;
});
function buildFrom(seedJob, say) {
  const job = jobOf(rng(seedJob), say);
  return run.buildPrompt(job) + NL + run.listenPrompt({ ...job, tasks: [{ title: say(), status: "working", asked_by: "Lee", chat: "c" }] });
}

// P9: a shared file and its name cannot open or close a fence either.
prop("P9", "shared files keep to their own fence", 150, (r) => [text(r, 6).join(""), text(r, 6).join(""), text(r, 10).join("")], ([from, name, body]) => {
  const t = materialsPrompt([{ from, name, body }]);
  return markers(t) === markers(materialsPrompt([{ from: "a", name: "b", body: "c" }])) ? "" : markers(t);
});

// Q5, P8: hiding secrets twice is hiding them once, it never makes text longer, and no key it knows survives.
prop("Q5", "hiding secrets is steady and never lengthens", 300, (r) => text(r, 16), (parts) => {
  const t = parts.join("");
  const once = hideSecrets(t);
  if (hideSecrets(once) !== once) return "hiding twice changed it";
  if (once.length > t.length) return "it grew";
  return /sk-ant-[A-Za-z0-9_-]{8,}/.test(once) ? "a key survived" : "";
});

// B1: the conversation handed over is the newest end of it, whole messages, within its room unless one message alone
// is bigger.
prop("B1", "history is the newest end, within its room", 300, (r) => r.list(40, () => ({ body: "x".repeat(r.pick([0, 1, 50, 900, 5000, 40000])) })), (history) => {
  const room = 48000;
  const out = run.recent(history, room);
  if (history.length && out[out.length - 1] !== history[history.length - 1]) return "the newest message was dropped";
  if (out.some((m, i) => m !== history[history.length - out.length + i])) return "not the newest end";
  const used = out.reduce((n, m) => n + m.body.length + 40, 0);
  return out.length > 1 && used > room ? `used ${used} of ${room}` : "";
});

// B5: the AI's output read in any chunks is the same events as read whole.
prop("B5", "output read in pieces is the same as read whole", 300, (r) => {
  const events = r.list(8, () => ({ type: r.pick(["result", "assistant", "rate_limit_event"]), text: text(r, 4).join("").replace(/\u0000/g, "") }));
  const lines = events.flatMap((e) => [JSON.stringify(e), ...r.list(1, () => r.pick(["", "not json", "  ", "{", "null"]))]);
  const whole = lines.join(NL) + (r.chance(0.5) ? NL : "");
  const cuts = [...new Set(r.list(10, () => r.int(whole.length + 1)))].sort((a, b) => a - b);
  return [{ keep: true, whole, cuts }];
}, ([c]) => {
  if (!c) return "";
  const read = (chunks) => { const got = []; const lr = lineReader((e) => got.push(JSON.stringify(e))); for (const ch of chunks) lr.push(ch); lr.end(); return got.join(NL); };
  const chunks = [];
  let at = 0;
  for (const cut of [...c.cuts, c.whole.length]) { chunks.push(c.whole.slice(at, cut)); at = cut; }
  return read(chunks) === read([c.whole]) ? "" : "different events";
});

// X2: a failure reason is one short line with no sign-in from an address and no key.
prop("X2", "a failure reason is one line with no sign-in", 300, (r) => r.list(6, () => r.pick([
  () => `fatal: unable to access 'https://${r.pick(["sam", "x-token", "a@b"])}:${r.pick(["pass", "p@ss", "p@s@s", "tok/en", "sk-ant-abcdefghij"])}@github.com/o/r.git/'`,
  () => NL, () => "\r\n", () => "plain words", () => "sk-ant-" + "b".repeat(20), () => "",
])()), (parts) => {
  const p = run.plain(new Error(parts.join("")));
  if (p.includes(NL) || p.length > 300) return "not one short line";
  if (/\/\/[^/\s]*@/.test(p)) return `a sign-in is left: ${p}`;
  return /pass|p@s|sk-ant-[a-z]{8,}/.test(p) ? `part of a password or key is left: ${p}` : "";
});

// P10, O7: a branch named from any chat is one the connection will write to.
prop("P10", "every chat name makes a branch the connection writes to", 300, (r) => text(r, 10), (parts) => { safeBranch(workBranch(parts.join(""))); return ""; });

// P15: whatever the parent has, the AI's own process gets only the names it needs.
const KEEP = new Set(["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "HOME", "USER", "LANG", "SHELL", "CLAUDE_CODE_OAUTH_TOKEN"]);
prop("P15", "the AI's process gets only the names it needs", 100, (r) => r.list(6, () => r.pick(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CONFIG_DIR", "NODE_OPTIONS", "GIT_DIR", "HTTPS_PROXY", "SUPABASE_KEY"])), (names) => {
  const before = { ...process.env };
  for (const n of names) process.env[n] = "x";
  try {
    const extra = Object.keys(childEnv("tok", null)).filter((k) => !KEEP.has(k));
    return extra.length ? `passed on: ${extra.join(", ")}` : "";
  } finally { for (const n of names) if (!(n in before)) delete process.env[n]; }
});

// B1, B5, E10: what a person's Claude knows stays within its size whatever their files hold, odd lines in their
// conversation lose nothing else, and the folder laid for it is whole or absent.
const project = join(scratch, "project");
mkdirSync(project, { recursive: true });
const sessions = join(process.env.LONGTABLE_CLAUDE_HOME, "projects", resolve(project).replace(/[^a-zA-Z0-9]/g, "-"));
prop("B1", "what a person's Claude knows stays within 36,000 characters, odd lines and all", 25, (r) => [
  { keep: true, home: r.int(12000), project: r.int(20000), memory: r.int(9000), notes: r.int(16), turns: r.int(40), odd: r.list(4, () => r.pick(["null", "5", "[]", "\"x\"", "{", "", "{\"type\":\"user\"}", "{\"type\":\"user\",\"message\":null}"])) },
], ([c]) => {
  if (!c) return "";
  rmSync(process.env.LONGTABLE_CLAUDE_HOME, { recursive: true, force: true });
  mkdirSync(join(sessions, "memory"), { recursive: true });
  writeFileSync(join(process.env.LONGTABLE_CLAUDE_HOME, "CLAUDE.md"), "h".repeat(c.home));
  writeFileSync(join(project, "CLAUDE.md"), "p".repeat(c.project));
  writeFileSync(join(sessions, "memory", "MEMORY.md"), "m".repeat(c.memory));
  for (let i = 0; i < c.notes; i++) writeFileSync(join(sessions, "memory", `n${i}.md`), "n".repeat(1500));
  const lines = [...Array.from({ length: c.turns }, (_, i) => JSON.stringify({ type: i % 2 ? "assistant" : "user", message: { content: `turn${i} ` + "w".repeat(3000) } })), ...c.odd, JSON.stringify({ type: "user", message: { content: "LAST-TURN" } })];
  writeFileSync(join(sessions, "s.jsonl"), lines.join(NL));
  const k = run.knows({ kind: "claude", folder: project });
  if (k.length > 36000) return `knows is ${k.length}`;
  if (!k.includes("LAST-TURN")) return "the newest turn was lost";
  const at = join(scratch, "lay");
  rmSync(at, { recursive: true, force: true });
  mkdirSync(at);
  const laid = run.layYours({ kind: "claude", folder: project }, at);
  const there = existsSync(join(at, run.YOURS));
  if (laid !== there) return `layYours said ${laid} but the folder is ${there ? "there" : "not there"}`;
  return laid && !readFileSync(join(at, run.YOURS, "recent-conversation.md"), "utf8").includes("LAST-TURN") ? "the laid conversation lost its newest turn" : "";
});

// B3: an AI's own notes stay at 40 short lines however much it writes.
prop("B3", "an AI's own notes stay at 40 short lines", 20, (r) => r.list(80, () => text(r, 6).join("") + " a note long enough"), (notes) => {
  const t = "00000000-0000-0000-0000-00000000000" + (notes.length % 10);
  for (const n of notes) run.remember(t, n);
  const kept = run.mind(t).split(NL).filter(Boolean);
  return kept.length > 40 || kept.some((l) => l.length > 320) ? `${kept.length} lines` : "";
});

// B3, P4-like: a table's id from the server never makes the connection write outside its own folders.
const { freshCopy } = await import("../../packages/connect/src/repo.mjs");
prop("B3", "a table id never leads outside the connection's own folders", 60, (r) => r.list(5, () => r.pick(["..", "/", "\\", "x", "minds", "copies", "11111111-2222-3333-4444-555555555555", "C:", "~", "%2e%2e", ""])), (parts) => {
  const id = parts.join("");
  // Everything the two may make is one file in minds/ or one folder in copies/; anything else anywhere is outside.
  const all = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [join(d, e.name), ...all(join(d, e.name))] : [join(d, e.name)]));
  const top = join(scratch, "..");
  const before = new Set([...all(process.env.LONGTABLE_HOME), ...readdirSync(top).map((f) => join(top, f))]);
  try { run.remember(id, "a note long enough to be kept"); } catch {}
  try { freshCopy(id, null); } catch {}
  const made = [...all(process.env.LONGTABLE_HOME), ...readdirSync(top).map((f) => join(top, f))].filter((f) => !before.has(f));
  const bad = made.filter((f) => !/[\\/]minds[\\/][A-Za-z0-9_-]+\.md$|[\\/]minds$|[\\/]copies[\\/][A-Za-z0-9_-]+$|[\\/]copies$/.test(f));
  for (const f of made) rmSync(f, { recursive: true, force: true });
  return bad.length ? `made ${bad.map((f) => f.slice(scratch.length)).join(", ")}` : "";
});

// P8 (the connection's side): no key shape it knows leaves in what it tells the table about a person's commands.
prop("P13", "a command's line never carries a key", 40, (r) => r.list(5, () => ({ name: `c${r.int(1000)}`, line: text(r, 5).join("").replace(/[\r\n]/g, " ") })), (cmds) => {
  rmSync(join(process.env.LONGTABLE_CLAUDE_HOME, "commands"), { recursive: true, force: true });
  mkdirSync(join(process.env.LONGTABLE_CLAUDE_HOME, "commands"), { recursive: true });
  for (const c of cmds) writeFileSync(join(process.env.LONGTABLE_CLAUDE_HOME, "commands", `${c.name}.md`), `---${NL}description: ${c.line}${NL}---${NL}body`);
  const told = run.toldCommands(scanCommands({ kind: "claude", folder: project }));
  const leak = told.find((c) => /sk-ant-[A-Za-z0-9_-]{8,}|\b[0-9a-f]{64}\b/i.test(c.about) || "file" in c);
  return leak ? `told: ${JSON.stringify(leak).slice(0, 120)}` : "";
});

// P14, B5: an attachment's address is only ever this table's own, and no address, however odd, throws.
const BASE = "https://db.example.test";
const TABLE = "11111111-2222-3333-4444-555555555555";
prop("P14", "an attachment address is this table's or refused, and never throws", 300, (r) => r.list(6, () => r.pick([
  "https://db.example.test", "https://evil.example.test", "http://db.example.test", "/storage/v1/object/sign/attachments/", TABLE, "/", "%2F", "%E0%A4%A", "%", "..", "x", "?token=1", "#", "/other-table/",
])), (parts) => {
  let url;
  try { url = new URL(parts.join(""), BASE); } catch { return ""; }
  const ok = attachmentAddress(BASE, TABLE, url);
  if (ok && url.origin !== BASE) return "another host was let through";
  return "";
});

// P11, P12, B2: however a path to a key is spelled, the key is never opened, copied or handed over in place, and no
// more than five places come back. The oracle is the files themselves: a secret is a file holding SECRET-.
const land = join(scratch, "land");
const proj = join(land, "proj");
const vault = join(land, "vault");
mkdirSync(join(proj, ".ssh"), { recursive: true });
mkdirSync(join(proj, "notes"), { recursive: true });
mkdirSync(vault, { recursive: true });
mkdirSync(join(land, "clean", "deep"), { recursive: true });
writeFileSync(join(proj, ".env"), "SECRET-ENV\n");
writeFileSync(join(proj, ".ssh", "id_rsa"), "SECRET-SSH\n");
writeFileSync(join(proj, "cert.pem"), "SECRET-PEM\n");
writeFileSync(join(proj, "notes", "a.md"), "plain notes\n");
writeFileSync(join(vault, ".env"), "SECRET-VAULT\n");
writeFileSync(join(land, "clean", "deep", "b.md"), "plain\n");
try { symlinkSync(vault, join(land, "clean", "door"), "junction"); } catch {}
const secretIds = [join(proj, ".env"), join(proj, ".ssh", "id_rsa"), join(proj, "cert.pem"), join(vault, ".env")].map((f) => statSync(f, { bigint: true }).ino);
const shortNames = {};
if (process.platform === "win32") {
  for (const dir of [land, proj]) {
    try {
      for (const l of execFileSync("cmd", ["/c", "dir", "/x", "/a", dir], { encoding: "utf8" }).split(/\r?\n/)) {
        const w = l.trim().split(/\s+/);
        if (w.length >= 5 && /~/.test(w[w.length - 2])) shortNames[w[w.length - 1]] = w[w.length - 2];
      }
    } catch {}
  }
}
const holdsSecret = (dir) => {
  const seen = new Set();
  const walk = (d) => {
    let real;
    try { real = realpathSync.native(d); } catch { return false; }
    if (seen.has(real)) return false;
    seen.add(real);
    for (const e of readdirSync(real, { withFileTypes: true })) {
      const p = join(real, e.name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory() ? walk(p) : /SECRET-/.test(readFileSync(p, "utf8"))) return true;
    }
    return false;
  };
  return walk(dir);
};
const TARGETS = [[".env"], [".ssh", "id_rsa"], ["cert.pem"], [".ssh"], []].map((t) => [proj, t]).concat([[land, ["clean"]], [vault, [".env"]], [vault, []]]);
const SPELL = {
  caseFlip: (p, r) => [...p].map((c) => (r.chance(0.4) ? (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) : c)).join(""),
  slash: (p) => p.replace(/\\/g, "/"),
  doubled: (p) => p.replace(/([^\\/:])[\\/]/, `$1${sep}${sep}`),
  dotSegment: (p) => p.replace(/[\\/]([^\\/]+)$/, `${sep}.${sep}$1`),
  upAndBack: (p) => p.replace(/[\\/]proj[\\/]/i, `${sep}proj${sep}notes${sep}..${sep}`),
  trailingDot: (p) => p + ".",
  trailingSpace: (p) => p + " ",
  stream: (p) => p + "::$DATA",
  stream2: (p) => p + ":$DATA",
  short: (p) => p.split(sep).map((part) => shortNames[part] || part).join(sep),
  longPrefix: (p) => (process.platform === "win32" ? `\\\\?\\${p}` : p),
  fileUri: (p) => `file:///${p}`,
};
prop("P11", "a key is never opened however its path is spelled", 150, (r) => {
  const [base, parts] = r.pick(TARGETS);
  const ops = r.list(4, () => r.pick(Object.keys(SPELL)));
  return [{ keep: true, base, parts, quote: r.pick(["", "\"", "'", "`"]), tail: r.pick(["", ".", ",", ")", " please"]), reading: r.chance(0.5), seed: r.int(1e9) }, ...ops];
}, ([c, ...ops]) => {
  if (!c) return "";
  const r = rng(c.seed);
  let p = join(c.base, ...c.parts);
  for (const op of ops) p = SPELL[op](p, r);
  const found = pointedPaths(`go through ${c.quote}${p}${c.quote}${c.tail} and tell me`);
  if (found.length > 5) return "more than five places";
  for (const f of found) {
    if (f.refused) continue;
    if (f.kind === "file" && secretIds.includes(statSync(f.real, { bigint: true }).ino)) return `a key was opened as ${p}`;
  }
  const work = join(scratch, "work");
  const laid = layPointed(work, found, { reading: c.reading });
  for (const d of laid.dirs) if (holdsSecret(d)) return `a folder holding a key was handed over where it is: ${p}`;
  for (const f of [...laid.files.map((x) => x.at), ...laid.copied.map((x) => x.at)]) {
    if (statSync(f).isDirectory() ? holdsSecret(f) : /SECRET-/.test(readFileSync(f, "utf8"))) return `a key was copied: ${p}`;
  }
  const shared = shareable(laid);
  if (shared.length > 8 || shared.some((s) => /SECRET-/.test(s.body))) return "a key was shared";
  return "";
});

// P12-side bound: whatever the message, no more than five places.
prop("B2", "no message points at more than five places", 40, (r) => r.list(12, () => `"${join(land, r.pick(["clean", "proj"]), r.pick(["notes", "deep", ""]))}"`), (paths) => (pointedPaths(paths.join(" ")).length > 5 ? "more than five" : ""));

// P12: a source the AI names is never in the folder of what is its person's alone, however it is written.
prop("P12", "a source is never a file of the person's own", 200, (r) => r.list(6, () => r.pick([".longtable-yours/memory/x.md", ".LONGTABLE-YOURS/x.md", "./.Longtable-Yours/a", "a.txt", "../a.txt", "/etc/passwd", "src\\..\\.longtable-yours\\x"])), (sources) => {
  const dir = join(scratch, "copy");
  mkdirSync(join(dir, ".longtable-yours", "memory"), { recursive: true });
  writeFileSync(join(dir, ".longtable-yours", "memory", "x.md"), "x");
  writeFileSync(join(dir, ".longtable-yours", "x.md"), "x");
  writeFileSync(join(dir, ".longtable-yours", "a"), "x");
  writeFileSync(join(dir, "a.txt"), "x");
  const out = run.cleanSources(dir, sources);
  const bad = out.find((s) => /^\.longtable-yours/i.test(s) || s.startsWith("..") || isAbsolute(s));
  return bad ? `kept ${bad}` : "";
});

// ---- saved: the smallest inputs that once broke a rule, run every time so the bug cannot come back
const saved = (rule, name, why) => { results.checked++; if (why) results.broken.push({ rule, name: `saved: ${name}`, seed: "-", step: 0, why, input: "" }); };
saved("X2", "a sign-in whose name and password hold an @", (() => {
  const p = run.plain(new Error("fatal: unable to access 'https://a@b:p@ss@github.com/o/r.git/'"));
  return p.includes("//github.com/o/r.git") && !/a@b|p@ss|ss@/.test(p) ? "" : p;
})());
saved("P12", "the person's own folder named in other letter case", (() => {
  const dir = join(scratch, "copy");
  return run.cleanSources(dir, ["./.Longtable-Yours/a", ".LONGTABLE-YOURS/x.md"]).length === 0 ? "" : "kept as a source";
})());
saved("P13", "a key in a command's description", (() => {
  const told = run.toldCommands([{ name: "c", about: "Use sk-ant-" + "a".repeat(20) + " and " + "f".repeat(64), kind: "command", file: "/x/c.md" }]);
  return /sk-ant-a|f{64}/.test(told[0].about) || "file" in told[0] ? JSON.stringify(told) : "";
})());
saved("B5", "an attachment address with a broken %-sequence", (() => {
  try { return attachmentAddress(BASE, TABLE, new URL(`${BASE}/storage/v1/object/sign/attachments/${TABLE}/%E0%A4%A`)) === false ? "" : "let through"; } catch (e) { return `threw: ${e.message}`; }
})());

rmSync(scratch, { recursive: true, force: true });
for (const b of results.broken) console.log(`BROKEN ${b.rule} "${b.name}" seed ${b.seed} step ${b.step}: ${b.why}${NL}  smallest input: ${b.input}${NL}  again: CHAOS_SEED=${b.seed} node tests/e2e/chaos-connect.mjs`);
console.log(`${results.checked} inputs checked, ${results.broken.length} rules broken`);
process.exit(results.broken.length ? 1 : 0);
