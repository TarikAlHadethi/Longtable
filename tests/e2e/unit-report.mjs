// The web app's error reports carry nothing personal. An error loaded with a made-up message, email, file name, local
// folder, key and request body goes through the real Sentry client with the web app's own settings
// (apps/web/lib/report.mjs), and what reaches the send step is read back: none of it may be there, while the kind of
// error, where in the code and the page's route shape still are. Also: reporting is off everywhere but the real site.
// No network: the send step is a stand-in that only records.
//
//   node tests/e2e/unit-report.mjs

import * as Sentry from "@sentry/node";
import { serializeEnvelope } from "@sentry/core";
import { PersonalError, browserReporting, reportOptions, routeShape, scrubBreadcrumb, scrubSpan, scrubText, serverReporting } from "../../apps/web/lib/report.mjs";

const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };

// Made-up, all of it. None of these may ever be sent.
const MESSAGE = "Elena wants the price list by Friday";
const EMAIL = "elena.fake@example.test";
const FILE = "booking screen final.png";
const USER = "mayafake";
const KEY = "sk-ant-api03-" + "Zq7Xw2Pv9Lm4Kj8Hn3Bt6Rc1Yd5Fs0Ga"; // scan:fake
const TABLE = "3f2b9c1e-7a4d-4e8b-9c2f-1a2b3c4d5e6f";
const SECRETS = [MESSAGE, "price list", EMAIL, "elena.fake", FILE, "booking screen", USER, KEY, TABLE, "Zq7Xw2Pv9Lm4"];

const sent = [];
const transport = () => ({ send: async (envelope) => { sent.push(serializeEnvelope(envelope)); return {}; }, flush: async () => true });

Sentry.init({
  ...reportOptions({ dsn: "https://00000000000000000000000000000000@o0.ingest.de.sentry.io/0", environment: "production", release: "test" }), // scan:fake
  transport,
  tracesSampleRate: 0,
});

Sentry.addBreadcrumb({ category: "console", message: `typing: ${MESSAGE} ${EMAIL}` });
Sentry.addBreadcrumb({ category: "fetch", data: { method: "post", url: `https://abc.supabase.co/rest/v1/rpc/client_say?t=${TABLE}`, status_code: 400, body: MESSAGE } });
Sentry.addBreadcrumb({ category: "ui.click", message: `button[aria-label="Remove ${FILE}"][data-testid="attach-remove"]` });
Sentry.addBreadcrumb({ category: "ui.click", message: `div.bubble > span "${MESSAGE}"` });
Sentry.addBreadcrumb({ category: "navigation", data: { from: `/t/${TABLE}?c=general`, to: `/join/${KEY}` } });

Sentry.withScope((scope) => {
  scope.setUser({ id: "u1", email: EMAIL, username: USER, ip_address: "203.0.113.9" });
  scope.setExtra("message", MESSAGE);
  scope.setTag("who", EMAIL);
  scope.setContext("chat", { words: MESSAGE, file: FILE });
  scope.setSDKProcessingMetadata({ normalizedRequest: { url: `https://longtable.chat/t/${TABLE}?c=general&email=${EMAIL}`, method: "POST", data: MESSAGE, cookies: { sb: KEY }, headers: { cookie: `sb=${KEY}`, "x-real-ip": "203.0.113.9" } } });
  const error = new Error(`Could not send "${MESSAGE}" for ${EMAIL} with ${FILE} from C:\\Users\\${USER}\\Desktop\\notes.txt using ${KEY}`);
  error.name = "SendError";
  Sentry.captureException(error);
});

// A database refusal names a person in its sentence; only its code goes out.
const refused = Object.assign(new Error(`${EMAIL} is not at this table`), { code: "P0001" });
Sentry.captureException(refused);
// An error built from a person's own words (the upload error carries the file's name): only its kind and place.
const personal = new PersonalError(`"${FILE}" could not be uploaded. ${MESSAGE} ${USER}`);
Sentry.captureException(personal);
// A storage or sign-in refusal with no database code, and a PostgREST one with details: their sentences stay home.
Sentry.captureException(Object.assign(new Error(`${EMAIL} may not read ${TABLE}/${FILE}`), { name: "StorageError", status: 403 }));
Sentry.captureException(Object.assign(new Error(`Results contain 0 rows for ${MESSAGE}`), { code: "PGRST116", details: MESSAGE, hint: EMAIL }));
await Sentry.flush(2000);

const all = sent.join("\n");
check("errors reach the send step", sent.length >= 5, sent.length);
const report = (type) => sent.find((s) => s.includes(`"type":"${type}"`)) || "";
check("an error built from a person's words goes out as its kind and place only", /"value":"message withheld"/.test(report("PersonalError")) && /unit-report\.mjs/.test(report("PersonalError")) && !/uploaded|booking|Elena|mayafake/i.test(report("PersonalError")), report("PersonalError").slice(0, 300));
check("a storage refusal with no code goes out without its sentence", /"value":"database error"/.test(report("StorageError")) && !/may not read/.test(report("StorageError")), report("StorageError").slice(0, 300));
check("a PostgREST refusal goes out as its code, without its details or hint", /database error PGRST116/.test(all) && !/Results contain/.test(all));
const leaks = SECRETS.filter((s) => all.toLowerCase().includes(s.toLowerCase()));
check("the made-up message, email and file name are all gone at the send step", ![MESSAGE, EMAIL, FILE].some((s) => all.includes(s)), leaks);
check("nor any part of them, the user's folder, the key, the table id or the address", leaks.length === 0, leaks);
check("no IP address, cookie, header or request body goes out", !/203\.0\.113\.9|cookie|x-real-ip|"data":"/i.test(all), all.match(/203\.0\.113\.9|cookie|x-real-ip/i));
check("no user, extra or chat context goes out", !/"user"|"extra"|"chat"|"who"/.test(all), all.match(/"user"|"extra"|"chat"|"who"/));
check("the kind of error and where in the code still go out", /SendError/.test(all) && /unit-report\.mjs/.test(all) && /"lineno":\d+/.test(all));
check("the page's route shape goes out, with no id in it", /"url":"\/t\/:id"/.test(all), all.match(/"url":"[^"]*"/g));
check("a database refusal goes out as its code only", /database error P0001/.test(all) && !/is not at this table/.test(all));
check("breadcrumbs keep where they went and what came back, never what was typed", /"\/rest\/v1\/rpc\/client_say"/.test(all) && /"status_code":400/.test(all) && /\[data-testid=attach-remove\]/.test(all) && !/typing:/.test(all) && /"\/join\/:token"/.test(all));

// The pieces, one at a time.
check("text: quoted words, emails, keys, local folders and file names are taken out", scrubText(`"${MESSAGE}" ${EMAIL} ${KEY} C:\\Users\\${USER}\\x ${FILE}`).match(/elena|price|sk-ant|mayafake|\.png/i) === null, scrubText(`"${MESSAGE}" ${EMAIL} ${KEY} C:\\Users\\${USER}\\x ${FILE}`));
check("text: a sign-in inside an address is taken out", !scrubText("https://maya:hunter2@example.test/x").includes("hunter2"));
check("text: a long error is cut to 300 characters", scrubText("x ".repeat(400)).length <= 301);
check("text: a long plain function name in a stack trace is kept", scrubText("renderTheWholeClientPageNow") === "renderTheWholeClientPageNow");
check("route: ids, invite tokens and emails become placeholders", routeShape(`/t/${TABLE}/settings?x=1`) === "/t/:id/settings" && routeShape(`/join/${KEY}`) === "/join/:token" && routeShape(`/u/${EMAIL}`) === "/u/:email");
check("route: a storage path loses every id and the file's name", !/booking|png|3f2b9c1e/.test(routeShape(`https://abc.supabase.co/storage/v1/object/sign/attachments/${TABLE}/${TABLE}/${TABLE}-${encodeURIComponent(FILE)}`)), routeShape(`https://abc.supabase.co/storage/v1/object/sign/attachments/${TABLE}/${TABLE}/${TABLE}-${encodeURIComponent(FILE)}`));
check("breadcrumb: a console line is dropped", scrubBreadcrumb({ category: "console", message: MESSAGE }) === null);
check("breadcrumb: a click with no test id is dropped", scrubBreadcrumb({ category: "ui.click", message: `span "${MESSAGE}"` }) === null);
const span = scrubSpan({ name: `GET /t/${TABLE}`, attributes: { "sentry.op": "http.server", "url.full": `https://longtable.chat/t/${TABLE}?e=${EMAIL}`, "user.email": EMAIL, "client.address": "203.0.113.9", "http.response.status_code": 200, "sentry.segment.name": `/t/${TABLE}` } });
check("span: its name and segment become route shapes, and only safe labels and numbers stay", span.name === "GET /t/:id" && span.attributes["sentry.segment.name"] === "/t/:id" && span.attributes["http.response.status_code"] === 200 && !JSON.stringify(span).match(/example\.test|203\.0|url\.full|user\.email|3f2b9c1e/), span);

// Reporting is on only on the real site.
check("server: on only for Vercel's production deploy with an address set", serverReporting({ VERCEL_ENV: "production", NEXT_PUBLIC_SENTRY_DSN: "x" }) && !serverReporting({ VERCEL_ENV: "preview", NEXT_PUBLIC_SENTRY_DSN: "x" }) && !serverReporting({ VERCEL_ENV: "production" }) && !serverReporting({ NEXT_PUBLIC_SENTRY_DSN: "x" }));
check("browser: on only on longtable.chat itself, on production, with an address set", browserReporting({ NEXT_PUBLIC_VERCEL_ENV: "production", NEXT_PUBLIC_SENTRY_DSN: "x" }, "longtable.chat")
  && !browserReporting({ NEXT_PUBLIC_VERCEL_ENV: "production", NEXT_PUBLIC_SENTRY_DSN: "x" }, "localhost")
  && !browserReporting({ NEXT_PUBLIC_VERCEL_ENV: "production", NEXT_PUBLIC_SENTRY_DSN: "x" }, "longtable-git-x.vercel.app")
  && !browserReporting({ NEXT_PUBLIC_VERCEL_ENV: "preview", NEXT_PUBLIC_SENTRY_DSN: "x" }, "longtable.chat"));
check("the settings send nothing personal by default, keep no local variables and time only a few visits", (() => { const o = reportOptions({}); return o.sendDefaultPii === false && o.includeLocalVariables === false && o.tracesSampleRate <= 0.05; })());

await Sentry.close(1000);
const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
