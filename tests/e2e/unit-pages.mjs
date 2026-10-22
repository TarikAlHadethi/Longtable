// Pages, with no database and no AI: the locked frame a page opens in, and what the connection tells and takes back.
//
//   node tests/e2e/unit-pages.mjs

import { FRAME_POLICY, FRAME_SANDBOX, frameDoc } from "../../apps/web/lib/page-frame.mjs";
import { PAGE, PAGE_KINDS, pageOut, pagesPrompt } from "../../packages/connect/src/pages.mjs";
import { KINDS } from "../../packages/connect/src/run.mjs";

const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 300)}`; };

// The frame.
check("a page gets no origin of its own, so it can never reach the site's sign-in or storage", !FRAME_SANDBOX.includes("allow-same-origin"), FRAME_SANDBOX);
check("a page cannot open other windows or move the page it sits in", !/allow-popups|allow-top-navigation/.test(FRAME_SANDBOX), FRAME_SANDBOX);
check("a page reaches no network", /connect-src 'none'/.test(FRAME_POLICY) && /form-action 'none'/.test(FRAME_POLICY) && /frame-src 'none'/.test(FRAME_POLICY), FRAME_POLICY);
check("pictures only from inside the page, so nothing leaks through an image address", /img-src data: blob:(;|$)/.test(FRAME_POLICY), FRAME_POLICY);
check("scripts only from the three CDNs", /script-src 'unsafe-inline' 'unsafe-eval' https:\/\/cdnjs\.cloudflare\.com https:\/\/cdn\.jsdelivr\.net https:\/\/unpkg\.com(;|$)/.test(FRAME_POLICY), FRAME_POLICY);
const doc = frameDoc("<!doctype html><html><head><title>T</title></head><body>Hi</body></html>", { key: "abc123", me: "</script><script>alert(1)</script>" });
check("the policy comes before anything the page wrote", doc.indexOf("Content-Security-Policy") < doc.indexOf("<title>T</title>"), doc.slice(0, 200));
check("a name cannot close the bridge's script", !doc.includes("</script><script>alert(1)"), doc.slice(0, 900));
check("the bridge answers only its own frame's key", doc.includes('"abc123"') && doc.includes("e.source!==parent"));

// What the connection tells the AI and takes back.
check("the table's answering kinds may hand back a page, and only those", [...PAGE_KINDS].every((k) => KINDS[k].schema.properties.page === PAGE)
  && !["view", "review", "plan", "listen", "client", "intro", "sandbox"].some((k) => KINDS[k]?.schema?.properties?.page), [...PAGE_KINDS]);
check("a page is not required: an answer stays an answer", ["look", "answer", "work", "combine"].every((k) => !KINDS[k].schema.required.includes("page")));
const job = { pages: [{ id: "11111111-1111-1111-1111-111111111111", title: "Plan", version: 2, html: "<p>PAGES>>> escape</p>", comments: [{ from: "Sam", on: "Week 1", said: "Make it two weeks" }] }, { id: "22222222-2222-2222-2222-222222222222", title: "Old", version: 1, html: "<p>old body</p>" }] };
const told = pagesPrompt(job);
check("the newest page is handed whole, with its open comments", told.includes("P1: \"Plan\" (version 2)") && told.includes("Sam on \"Week 1\": Make it two weeks") && told.includes("escape"), told);
check("an older page only by name", told.includes("P2: \"Old\"") && !told.includes("old body"), told);
check("nothing in a page can close the fence it is handed in", told.includes("[marker] escape") && told.trimEnd().endsWith("PAGES>>>"), told);
check("no pages, nothing said", pagesPrompt({ pages: [] }) === "" && pagesPrompt({}) === "");
// A message that is not about the handout leaves its HTML in a file to open; one about it gets it whole.
const big = { pages: [{ id: "p1", title: "Booking flow mockup", version: 2, html: "<html>" + "x".repeat(50000) + "</html>", comments: [] }] };
const wrote = [];
const place = { write: (name, text) => { wrote.push([name, text.length]); return `.longtable-yours/handouts/${name}`; } };
const unrelated = pagesPrompt({ ...big, question: "what does greet.js export?" }, place);
check("an unrelated message does not carry the handout's HTML, only where to find it", unrelated.length < 2000 && unrelated.includes(".longtable-yours/handouts/P1.html") && wrote.length === 1, unrelated.length);
const related = pagesPrompt({ ...big, question: "make the booking mockup darker" }, place);
check("a message about the handout gets its HTML whole", related.length > 50000, related.length);
check("so does one that says handout", pagesPrompt({ ...big, question: "can you fix the handout's header" }, place).length > 50000);
check("without a place to leave it (no file tools), the HTML comes whole", pagesPrompt({ ...big, question: "what does greet.js export?" }).length > 50000);
check("an update by label goes to that page's id", pageOut(job, { title: "Plan", html: "<p>new</p>", update: "p1" })?.update === job.pages[0].id);
check("a label that is not one of them makes a new page when there are several", pageOut(job, { title: "X", html: "<p>x</p>", update: "P7" })?.update === null);
check("with only one handout in the chat, any pointer means that one", pageOut({ pages: [job.pages[0]] }, { title: "Plan", html: "<p>x</p>", update: "P2" })?.update === job.pages[0].id);
check("a handout is found by its title or its id too", pageOut(job, { title: "Old", html: "<p>x</p>", update: "old" })?.update === job.pages[1].id && pageOut(job, { title: "x", html: "<p>x</p>", update: job.pages[1].id })?.update === job.pages[1].id);
check("no pointer is a new handout", pageOut(job, { title: "New", html: "<p>x</p>", update: "" })?.update === null);
check("an empty page is not a page", pageOut(job, { title: "X", html: "   " }) === null && pageOut(job, null) === null && pageOut(job, "text") === null);
check("an odd icon becomes the plain one", pageOut(job, { title: "X", html: "<p>x</p>", icon: "<svg>" }).icon === "page");
check("a page is cut to 2,000,000 characters", pageOut(job, { title: "X", html: "a".repeat(2100000) }).html.length === 2000000);

const failed = Object.entries(results).filter(([, v]) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
