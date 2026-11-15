// What a change in a client's copy may never touch, checked by the connection on the change itself.

// What a sandbox change may never be, whatever was asked. The connection checks the change itself, never the AI's
// word for it, and it checks every file the change touched as a whole, not only the new lines.
// It is a strong filter, not a wall: a copy is still code a client asked for, running where the team puts it up, so
// that place must hold no real keys and no real data. The owner is told so before giving a copy.
// Each rule is written once and both modes are built from them, so tightening one can never miss the other.
const BUILD_FILES = [
  // how the product is built, set up, deployed and versioned
  "(^|/)[.]git(hub|lab|attributes|modules|ignore)", "(^|/)[.](circleci|husky|vscode|devcontainer)/", "(^|/)[.]env", "(^|/)[.](npmrc|yarnrc|babelrc|vercelignore|dockerignore)",
  "(^|/)(package|composer|turbo|tsconfig[^/]*|jsconfig|vercel|netlify|firebase|app|now)[.]json$", "[.](toml|ya?ml|lock|lockb|sql|sh|bat|ps1|cjs|mjs|pem|key|crt)$",
  "(^|/)(package-lock[.]json|Dockerfile[^/]*|docker-compose[^/]*|Makefile|Procfile|Gemfile|requirements[^/]*[.]txt|go[.](mod|sum))$", "[.]config[.][cm]?[jt]sx?$",
];
const SAFETY_FILES = [
  // sign-in and who may do what
  "(^|[/._-])(auth|login|signin|sign-in|session|permissions?|polic(y|ies)|rls|guard|admin|secrets?|credentials?)([/._-]|$)",
  // Words that are also ordinary parts of a name ("role-picker", "token-list") only count as a whole folder or file.
  "(^|/)(roles?|tokens?|keys?)([/.]|$)",
  // tests, so one cannot be changed to pass
  "(^|/)(tests?|__tests__|e2e|spec|cypress|playwright)/", "[.](test|spec)[.]",
];
const REACHES_OUT = [
  "\\bprocess\\s*\\??\\.[A-Za-z_$]", "\\bprocess\\s*\\[", "[=(,:]\\s*process\\s*[;),}\\]]", "[=(,:]\\s*process\\s*$", "import\\s*[.]\\s*meta", "\\b(Deno|Bun)\\s*[.]",
  "\\benv\\s*\\[", "\\benv\\s*\\??\\.[A-Za-z_$]", "[{,]\\s*env\\s*[,})]", "\\bgetenv\\b", "os[.]environ", "\\bENV\\s*[\\[.]",
  "\\b(readFile|readFileSync|readdir|readdirSync|createReadStream|child_process|execSync|spawn)\\b", "[\"'`](node:)?(fs|fs/promises|vm|net|dns|child_process|worker_threads)[\"'`]",
  // The server's other ways out, named where a module is asked for, so "http" in an ordinary sentence is left alone.
  "\\b(require|import)\\s*\\(\\s*[\"'`](node:)?(https?|http2|os|tls|dgram|module)[\"'`]", "\\bfrom\\s*[\"'`](node:)?(https?|http2|os|tls|dgram|module)[\"'`]",
  "\\beval\\s*\\(", "new\\s+Function\\b", "\\bFunction\\s*\\(",
];
const REACHES_OUT_TOO = ["\\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\\b[^;]{0,80}(https?:|[\"'`]//)", "<script\\b", "\\bsecrets[.][A-Za-z_]"];
const NOT_IN_A_SANDBOX = new RegExp([
  ...BUILD_FILES,
  // what runs on the server or at build time
  "(^|/)(scripts?|migrations?|supabase|prisma|drizzle|db|database|server|functions|workers?|lambda|infra|deploy|ops|bin|tools)/",
  "(^|/)(api|trpc|actions?)/", "(^|/)(route|middleware|instrumentation|proxy|actions?|server)[.][cm]?[jt]sx?$",
  ...SAFETY_FILES,
].join("|"), "i");
const NOT_A_SANDBOX_WORD = new RegExp([...REACHES_OUT, "\\bglobalThis\\b", "[\"']use server[\"']", "\\bserver-only\\b", "dangerouslySetInnerHTML", ...REACHES_OUT_TOO].join("|"), "m");
// With the table's copy rules set to "code" (a preview that is fully separate: made-up data, no real keys, no email),
// a copy may also change the code behind the screens: server components, actions, API routes. Still never how the
// product is built, set up or deployed, migrations and the database, scripts, middleware, sign-in and permissions,
// or tests; and the code still may not reach for env values, programs, files or outside sites.
const NOT_IN_A_CODE_COPY = new RegExp([
  ...BUILD_FILES,
  "(^|/)(scripts?|migrations?|supabase|prisma|drizzle|infra|deploy|ops|bin|tools|docker)/",
  "(^|/)(middleware|instrumentation|proxy)[.][cm]?[jt]sx?$",
  ...SAFETY_FILES,
].join("|"), "i");
const NOT_A_CODE_COPY_WORD = new RegExp([...REACHES_OUT, "dangerouslySetInnerHTML", ...REACHES_OUT_TOO].join("|"), "m");
// The owner's own list of paths a copy may never change, whatever the mode: a folder ends in "/", anything else is a
// file or a folder by that name.
export const blockedList = (blocked) => String(blocked || "").split(/[,\n]/).map((x) => x.trim().replace(/^[/]+/, "")).filter(Boolean);
const isBlocked = (f, list) => list.some((b) => (b.endsWith("/") ? f.startsWith(b) : f === b || f.startsWith(b + "/")));

export function sandboxRefusal({ files, text, unread }, paths = "", { scope = "screens", blocked = "" } = {}) {
  const code = scope === "code";
  const theirs = blockedList(blocked);
  const kept = theirs.length ? files.find((f) => isBlocked(f, theirs)) : null;
  if (kept) return `it changes ${kept}, which this table keeps out of every copy`;
  const file = files.find((f) => (code ? NOT_IN_A_CODE_COPY : NOT_IN_A_SANDBOX).test(f));
  if (file) return `it changes ${file}, which is part of how the product is built, run or kept safe`;
  // Folders the owner said a copy may change: with any set, everything outside them is the team's.
  const allowed = String(paths || "").split(",").map((x) => x.trim().replace(/^[/]+|[/]+$/g, "")).filter(Boolean);
  const outside = allowed.length ? files.find((f) => !allowed.some((a) => f === a || f.startsWith(a + "/"))) : null;
  if (outside) return `it changes ${outside}, which is outside the folders a copy may change`;
  if (unread) return "it changes a file that could not be read through";
  const word = (code ? NOT_A_CODE_COPY_WORD : NOT_A_SANDBOX_WORD).exec(text || "");
  if (word) return `a file it changed reaches for something a copy must not (${word[0].trim().slice(0, 40)})`;
  return null;
}

