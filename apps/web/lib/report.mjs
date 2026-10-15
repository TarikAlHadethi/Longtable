// Error reports for the web app, and the scrubber every report goes through first. Reporting is on only on the real
// site (longtable.chat, Vercel's production) and only when a Sentry address is set; development, previews and tests
// send nothing. What is sent is built up from a short list of things known to be safe, never cut down from the whole:
// the kind of error, where in the code, the browser and the page's route shape. Messages, client chats, prompts,
// file names, emails, names, addresses, tokens, cookies and request bodies never leave. Anything unsure is dropped.
// Plain JavaScript, so tests/e2e/unit-report.mjs can run it through the real Sentry client with no build.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// The key shapes tools/scan-staged.mjs knows, then anything long and random (table ids and invite tokens too).
const KEYS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bnpm_[A-Za-z0-9]{16,}/g,
  /\bre_[A-Za-z0-9_]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bsb_(?:publishable|secret)_[A-Za-z0-9_-]{8,}/g,
  // Long and random: letters and digits mixed. A long plain function name in a stack trace is left as it is.
  /(?=[A-Za-z_-]*\d)(?=[0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}/g,
];
// A sign-in carried inside an address: a name and a password before the host.
const SIGN_IN = /\/\/[^/\s:@]+:[^/\s@]+@/g;
// Whatever was quoted in a message is somebody's words or a file's name: our own errors quote both.
const QUOTED = /"[^"\n]{0,400}"|'[^'\n]{0,400}'|`[^`\n]{0,400}`|“[^”\n]{0,400}”/g;
// A file name can have spaces in it ("booking screen final.png"), so the few words before it go too.
const FILE = /(?:[^\s"'`/\\:]+ ){0,4}[^\s"'`/\\:]+\.(?:png|jpe?g|gif|webp|heic|heif|bmp|svg|ico|pdf|docx?|xlsx?|pptx?|csv|tsv|txt|md|rtf|odt|zip|rar|7z|gz|tar|mp4|mov|webm|mkv|avi|m4a|mp3|wav|ogg|flac|json|xml|ya?ml|log|sql|key|pem)\b/gi;
const LOCAL_PATH = /[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\s"']+|\/(?:home|Users)\/[^/\s"']+/gi;
const MAX = 300;

// Any text that may leave: quoted words, emails, sign-ins, keys, local folders and file names taken out, then cut.
export function scrubText(text) {
  if (typeof text !== "string") return "";
  let out = text.replace(QUOTED, ":text").replace(SIGN_IN, "//:sign-in@").replace(EMAIL, ":email").replace(LOCAL_PATH, ":local");
  for (const re of KEYS) out = out.replace(re, ":key");
  out = out.replace(FILE, ":file");
  return out.length > MAX ? `${out.slice(0, MAX)}…` : out;
}

// A page address reduced to its shape: no host, no query, no ids, tokens, emails or names.
export function routeShape(address) {
  if (typeof address !== "string" || !address) return undefined;
  let path = address;
  try { path = new URL(address, "https://longtable.chat").pathname; } catch { path = address.split(/[?#]/)[0]; }
  // Plain words stay (t, join, api, rpc, client_say); anything that looks like an id, a token or a name does not.
  const parts = path.split("/").map((part, i, all) => {
    if (!part) return part;
    let p = part;
    try { p = decodeURIComponent(part); } catch {}
    if (all[i - 1] === "join") return ":token";
    if (/@/.test(p)) return ":email";
    if (/\d/.test(p) && /^[0-9a-f-]{8,}$/i.test(p) || /^[A-Za-z0-9_-]{20,}$/.test(p)) return ":id";
    return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(p) ? p : ":part";
  });
  return parts.join("/") || "/";
}

// An error whose words are a person's: a file's name, what they typed. Shown to them as it is; in a report only its
// kind and where it was thrown go out, never its message.
export class PersonalError extends Error {
  constructor(message) {
    super(message);
    this.name = "PersonalError";
  }
}

// What stands in for an error's message when the message itself may not go out, or null when it may (scrubbed).
// A database, storage or sign-in refusal says who and what in its sentence ("raise exception", a path, an email), so
// only its code goes out.
function withheld(original) {
  if (!original || typeof original !== "object") return null;
  if (original instanceof PersonalError || original.name === "PersonalError") return "message withheld";
  const code = typeof original.code === "string" ? original.code : null;
  if (code && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(code)) return `database error ${code}`;
  const named = String(original.name || original.constructor?.name || "");
  const fromStore = /^(?:Postgrest|Storage|Auth|Functions)\w*Error$/.test(named) || "details" in original || "hint" in original
    || typeof original.status === "number" || typeof original.statusCode === "number" || typeof original.statusCode === "string";
  if (fromStore) return code && /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? `database error ${code}` : "database error";
  return null;
}

function frame(f) {
  if (!f || typeof f !== "object") return null;
  const out = {};
  if (typeof f.filename === "string") out.filename = scrubText(f.filename);
  if (typeof f.abs_path === "string") out.abs_path = scrubText(f.abs_path);
  if (typeof f.module === "string") out.module = scrubText(f.module);
  if (typeof f.function === "string") out.function = scrubText(f.function);
  for (const k of ["lineno", "colno"]) if (typeof f[k] === "number") out[k] = f[k];
  if (typeof f.in_app === "boolean") out.in_app = f.in_app;
  return out;
}

function exception(value, original) {
  const instead = withheld(original);
  const out = { type: typeof value.type === "string" ? scrubText(value.type) : "Error", value: instead ?? scrubText(value.value) };
  if (value.mechanism && typeof value.mechanism === "object") out.mechanism = { type: String(value.mechanism.type || "generic"), handled: value.mechanism.handled !== false };
  const frames = value.stacktrace?.frames;
  if (Array.isArray(frames)) out.stacktrace = { frames: frames.slice(-60).map(frame).filter(Boolean) };
  return out;
}

const CONTEXT_KEEP = { browser: ["name", "version"], os: ["name", "version"], runtime: ["name", "version"], trace: ["trace_id", "span_id", "parent_span_id", "op", "status"] };

// An error report, rebuilt from what is safe. Nothing else on the event survives.
export function scrubEvent(event, hint) {
  if (!event || typeof event !== "object") return null;
  const out = {};
  for (const k of ["event_id", "timestamp", "start_timestamp", "level", "platform", "environment", "release", "dist", "type"]) if (event[k] !== undefined) out[k] = event[k];
  if (event.sdk) out.sdk = { name: event.sdk.name, version: event.sdk.version };
  if (Array.isArray(event.exception?.values)) out.exception = { values: event.exception.values.slice(-5).map((v) => exception(v, hint?.originalException)) };
  if (typeof event.message === "string") out.message = scrubText(event.message);
  else if (event.logentry?.message) out.message = scrubText(event.logentry.message);
  if (typeof event.transaction === "string") out.transaction = routeShape(event.transaction.replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /, "")) ?? "";
  const route = routeShape(event.request?.url);
  if (route) out.request = { url: route };
  const contexts = {};
  for (const [name, keys] of Object.entries(CONTEXT_KEEP)) {
    const c = event.contexts?.[name];
    if (!c || typeof c !== "object") continue;
    contexts[name] = Object.fromEntries(keys.filter((k) => c[k] !== undefined).map((k) => [k, typeof c[k] === "string" ? scrubText(c[k]) : c[k]]));
  }
  if (Object.keys(contexts).length) out.contexts = contexts;
  if (route) out.tags = { route };
  if (Array.isArray(event.breadcrumbs)) out.breadcrumbs = event.breadcrumbs.map((b) => scrubBreadcrumb(b)).filter(Boolean);
  const images = event.debug_meta?.images;
  if (Array.isArray(images)) out.debug_meta = { images: images.map((im) => ({ type: im.type, debug_id: im.debug_id, code_file: scrubText(im.code_file) })) };
  return out;
}

// A breadcrumb keeps where it went and what came back, never what was said, typed or sent.
export function scrubBreadcrumb(crumb) {
  if (!crumb || typeof crumb !== "object") return null;
  const base = { timestamp: crumb.timestamp, category: crumb.category, type: crumb.type, level: crumb.level };
  const data = crumb.data || {};
  switch (crumb.category) {
    case "navigation":
      return { ...base, data: { from: routeShape(data.from), to: routeShape(data.to) } };
    case "fetch":
    case "xhr":
      return { ...base, data: { method: typeof data.method === "string" ? data.method.toUpperCase().slice(0, 8) : undefined, url: routeShape(data.url), status_code: typeof data.status_code === "number" ? data.status_code : undefined } };
    case "ui.click":
    case "ui.input": {
      const id = String(crumb.message || "").match(/\[data-testid=["']?([A-Za-z0-9_-]{1,60})/)?.[1];
      return id ? { ...base, message: `[data-testid=${id}]` } : null;
    }
    default:
      return null;
  }
}

// What a performance span may keep: numbers, and a few plain labels. Its name becomes a route shape.
const SPAN_STRINGS = new Set(["sentry.op", "sentry.origin", "sentry.source", "sentry.environment", "sentry.release", "sentry.sdk.name", "sentry.sdk.version", "sentry.segment.id", "sentry.segment.name", "http.request.method", "http.method", "browser.name"]);
const SPAN_SHAPED = new Set(["sentry.segment.name"]);
const SPAN_NEVER = /url|path|query|user|ip|email|address|host|cookie|header|body|name|file|message|db\.|statement|args/i;

export function scrubSpan(span) {
  if (!span || typeof span !== "object") return span;
  const attributes = {};
  for (const [key, raw] of Object.entries(span.attributes || {})) {
    const value = raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
    if ((typeof value === "number" || typeof value === "boolean") && !SPAN_NEVER.test(key.replace(/^sentry\./, ""))) attributes[key] = value;
    else if (typeof value === "string" && SPAN_STRINGS.has(key)) attributes[key] = SPAN_SHAPED.has(key) ? routeShape(value.replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /, "")) : scrubText(value);
  }
  const method = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /.exec(span.name || "")?.[1];
  const shaped = routeShape(String(span.name || "").replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /, ""));
  const name = /^\//.test(String(span.name || "").replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /, "")) ? `${method ? `${method} ` : ""}${shaped}` : scrubText(span.name);
  return { ...span, name, attributes, links: undefined };
}

// The settings every Sentry start uses. Nothing personal by default, a little timing, the scrubber on every path out.
export function reportOptions({ dsn, environment, release }) {
  return {
    dsn,
    environment,
    release,
    sendDefaultPii: false,
    includeLocalVariables: false,
    attachStacktrace: true,
    maxBreadcrumbs: 30,
    tracesSampleRate: 0.02,
    beforeSend: (event, hint) => scrubEvent(event, hint),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
    beforeSendSpan: (span) => scrubSpan(span),
  };
}

// On the server: the real site's production deploy only, and only with an address set.
export function serverReporting(env = process.env) {
  return env.VERCEL_ENV === "production" && !!env.NEXT_PUBLIC_SENTRY_DSN;
}

// In the browser: the same, and the page really is longtable.chat.
export function browserReporting(env, host) {
  return env.NEXT_PUBLIC_VERCEL_ENV === "production" && !!env.NEXT_PUBLIC_SENTRY_DSN && host === "longtable.chat";
}
