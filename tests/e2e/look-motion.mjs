// Pictures of the newest things while they move: what is attached waiting by the box, one being taken off, the list
// behind "/", a message with things on it, the small print under an answer, the windows of an AI and of the table,
// and the client's side. A fake connection stands in for the AI. Writes PNGs to the folder in SCREENSHOTS, and
// checks that each of these really arrives with motion and settles, so none of them goes back to blinking in.
//
//   SCREENSHOTS=<folder> node --experimental-websocket tests/e2e/look-motion.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { accessToken, API, KEY, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

const out = process.env.SCREENSHOTS;
if (!out) throw new Error("Set SCREENSHOTS to a folder.");
const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "")}`.slice(0, 400); };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => (await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) })).json().catch(() => null);

// A picture big enough to see: plain bands of colour, written by hand so the test needs no image library.
function picture(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  const bands = [[92, 143, 128], [224, 196, 150], [70, 92, 110], [236, 232, 222]];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = bands[Math.floor(((x + y) / (width + height)) * bands.length) % bands.length];
    rows.set([r, g, b], y * (width * 3 + 1) + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const stuff = mkdtempSync(join(tmpdir(), "longtable-motion-"));
const png = join(stuff, "booking screen.png");
const note = join(stuff, "room note.txt");
const sheet = join(stuff, "prices 2026.csv");
writeFileSync(png, picture(640, 400));
writeFileSync(note, "The planning meeting is on Thursday.");
writeFileSync(sheet, "item,price\ncheck-up,40\n");

// The names of the animations running on the first thing a selector finds, and on everything inside it.
const moving = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  return el ? el.getAnimations({ subtree: true }).map((a) => a.animationName || a.transitionProperty || "x") : null;
}, selector);
const settled = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return "missing";
  const s = getComputedStyle(el);
  return s.opacity === "1" && (s.transform === "none" || s.transform === "matrix(1, 0, 0, 1, 0, 0)") ? null : `${s.opacity} ${s.transform}`;
}, selector);

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const table = owner.tableId;
  const token = await accessToken(owner.context);
  const code = (await rpc(token, "start_pairing", { t: table, ai_kind: "claude" })).body;
  const device = (await anon("pair_connection", { code, device_label: "look" })).token;
  sql(`update public.jobs set status = 'skipped' where table_id = '${table}' and kind = 'intro'`);
  await anon("runner_hello", { token: device });
  await anon("runner_commands", { token: device, list: [
    { name: "review", about: "Read the change and say what is wrong with it", kind: "command" },
    { name: "release-notes", about: "Write what changed for the people who use it", kind: "command" },
    { name: "house-style", about: "How this team writes", kind: "skill" },
    { name: "standup", about: "What moved since yesterday, in three lines", kind: "command" },
    { name: "helper:plan", about: "Plan the work before starting it", kind: "command" },
    { name: "code-review", about: "Read code for bugs and say what is wrong, most serious first", kind: "builtin" },
    { name: "security-review", about: "Look for ways the code could be misused or leak something", kind: "builtin" },
    { name: "simplify", about: "Make code simpler without changing what it does", kind: "builtin" },
    { name: "init", about: "Write or improve the project's CLAUDE.md", kind: "builtin" },
    { name: "debug", about: "Find the cause of a problem by reading the code", kind: "builtin" },
    { name: "verify", about: "Check that a change does what it claims", kind: "builtin" },
  ] });
  const pulse = setInterval(() => anon("runner_hello", { token: device }), 8000);
  const chat = (await rest(token, `chats?select=id&table_id=eq.${table}`)).body[0].id;

  const p = owner.page;
  await p.setViewportSize({ width: 1440, height: 1000 });
  await p.reload();
  await p.waitForSelector("[data-testid=attach-button]");
  await sleep(600);

  // Attaching: each thing arrives by the box, and one taken off leaves before it is gone.
  await p.setInputFiles("[data-testid=attach-input]", [png, note, sheet]);
  await p.waitForSelector("[data-testid=attach-tray]");
  const arriving = await moving(p, "[data-testid=attach-tray]");
  check("what is attached arrives by the box instead of blinking in", arriving?.some((n) => /at-in/.test(n)), arriving);
  await sleep(90);
  await p.screenshot({ path: `${out}/motion-tray-arriving.png` });
  await sleep(500);
  check("and comes to rest", (await settled(p, "[data-testid=attach-tray] > div")) === null, await settled(p, "[data-testid=attach-tray] > div"));
  await p.screenshot({ path: `${out}/motion-tray.png` });
  await p.click("[aria-label='Remove prices 2026.csv']");
  const going = await moving(p, "[data-testid=attach-tray]");
  check("one taken off is seen leaving", going?.some((n) => /at-out/.test(n)), going);
  await sleep(500);
  check("and then it is gone, with the others still waiting", (await p.locator("[data-testid=attach-tray] > div").count()) === 2 && !/prices/.test(await p.textContent("[data-testid=attach-tray]")));

  // Files held over the box.
  await p.evaluate(() => {
    const wrap = document.querySelector("[data-testid=attach-tray]").parentElement;
    const data = new DataTransfer();
    data.items.add(new File(["x"], "held.txt", { type: "text/plain" }));
    wrap.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await sleep(350);
  check("the box shows where held files will land", await p.evaluate(() => document.querySelector("[data-testid=attach-tray]").parentElement.dataset.drop === "1"));
  await p.screenshot({ path: `${out}/motion-drop.png` });
  await p.evaluate(() => document.querySelector("[data-testid=attach-tray]").parentElement.dispatchEvent(new DragEvent("dragleave", { bubbles: true, relatedTarget: null })));
  check("and lets go when they are taken away", await p.evaluate(() => document.querySelector("[data-testid=attach-tray]").parentElement.dataset.drop === undefined));

  // The list behind "/".
  await p.fill("textarea", "/");
  await p.waitForSelector("[data-testid=slash-menu]");
  const list = await moving(p, "[data-testid=slash-menu]");
  check("the list of her own commands opens with each line arriving in turn", list?.some((n) => /lt-slash/.test(n)) && list.filter((n) => /lt-rise/.test(n)).length >= 4, list);
  const offered = await p.locator("[data-testid=slash-menu] [role=option]").allTextContents();
  check("every command is offered, her own first, then the ones the table runs, then the rest of Claude Code's", offered.length > 11 && /helper:plan/.test(offered[0]) && /standup/.test(offered[4]) && /code-review/.test(offered[5]) && /Built in/.test(await p.textContent("[data-testid=slash-menu]")) && /Claude Code.s own/.test(await p.textContent("[data-testid=slash-menu]")) && /verify/.test(offered[10]), offered.map((t) => t.slice(0, 18)));
  await sleep(90);
  await p.screenshot({ path: `${out}/motion-slash-opening.png` });
  await sleep(500);
  check("and the list comes to rest", (await settled(p, "[data-testid=slash-menu]")) === null && (await settled(p, "[data-testid=slash-menu] button:last-child")) === null);
  await p.keyboard.press("ArrowDown");
  await sleep(250);
  await p.screenshot({ path: `${out}/motion-slash.png` });
  for (let i = 0; i < 9; i++) await p.keyboard.press("ArrowDown");
  await sleep(300);
  check("the arrows reach the last one and keep it in sight", await p.evaluate(() => { const list = document.querySelector("[data-testid=slash-menu]"); const on = list.querySelector("[aria-selected=true]"); const a = list.getBoundingClientRect(), b = on.getBoundingClientRect(); return /verify/.test(on.textContent) && b.top >= a.top - 1 && b.bottom <= a.bottom + 1; }));
  await p.screenshot({ path: `${out}/motion-slash-end.png` });
  const box = await p.evaluate(() => { const f = document.querySelector("textarea").closest("form").getBoundingClientRect(); const t = document.querySelector("textarea").getBoundingClientRect(); return { left: Math.round(t.left - f.left), top: Math.round(t.top - f.top), width: Math.round(f.width) }; });
  check("the words in the box keep well clear of its edge, and the box is wider than the messages", box.left >= 22 && box.top >= 9 && box.width > 730, box);
  await p.keyboard.type("re");
  await sleep(200);
  check("typing more of a name starts again from the best match", (await p.getAttribute("[data-testid=slash-menu] button:first-child", "aria-selected")) === "true" && /release-notes/.test(await p.textContent("[data-testid=slash-menu] button:first-child")));
  await p.fill("textarea", "");

  // A message with things on it, then an answer with its small print.
  await p.fill("textarea", "here is the booking screen and the note about Thursday");
  await p.click("button:has-text('Send')");
  await p.waitForSelector("[data-testid=files] img", { timeout: 20000 });
  await sleep(900);
  check("what a message carries has come to rest", (await settled(p, "[data-testid=files] a")) === null, await settled(p, "[data-testid=files] a"));
  const heights = await p.evaluate(() => [...document.querySelectorAll("[data-testid=files] > *")].map((el) => Math.round(el.getBoundingClientRect().height)));
  check("a file beside a picture keeps its own height", heights.length === 2 && heights[1] < 60, heights);
  await p.screenshot({ path: `${out}/motion-files.png` });
  await p.hover("[data-testid=files] img");
  await sleep(450);
  await p.screenshot({ path: `${out}/motion-files-hover.png` });

  await rpc(token, "ask_table", { c: chat, body: "Where does the booking form check the date?" });
  let job = null;
  for (let i = 0; i < 40 && !job; i++) { job = (await anon("runner_claim", { token: device, lane: "heavy" })) || (await anon("runner_claim", { token: device, lane: "light" })); if (!job) await sleep(500); }
  await anon("runner_finish", { token: device, job: job.job_id, answer: "The date is checked in **two places**.\n\n- `booking-form.tsx` refuses a day in the past before anything is sent.\n- `book_slot` in the database refuses it again, so a changed page cannot get round it.", info: { read: "main @ a1b2c3d", sources: [] } });
  await p.waitForSelector("[data-ai='true']", { timeout: 20000 });
  await sleep(700);
  await p.hover("[data-ai='true']");
  await sleep(450);
  check("the small print under an answer eases into place when pointed at", await p.evaluate(() => { const f = document.querySelector("[data-ai='true'] [class*=aiFoot]"); if (!f) return true; const s = getComputedStyle(f); return s.opacity === "1" && /transform/.test(s.transitionProperty); }));
  await p.screenshot({ path: `${out}/motion-answer-hover.png` });

  // The windows.
  await p.click("[data-testid=home]");
  await p.click("[data-testid=table-home] [data-seat-ai=claude]");
  await p.waitForSelector("[data-testid=ai-window]");
  const win = await moving(p, "[data-testid=ai-window]");
  check("an AI's window sets itself out part by part", win?.some((n) => /pn-pop/.test(n)) && win.filter((n) => /pn-in/.test(n)).length >= 3, win);
  await sleep(110);
  await p.screenshot({ path: `${out}/motion-ai-window-opening.png` });
  await sleep(900);
  const stuck = await p.evaluate(() => [...document.querySelectorAll("[data-testid=ai-window] > *")].filter((el) => { const s = getComputedStyle(el); return s.opacity !== "1" || s.transform !== "none"; }).length);
  check("and every part comes to rest where it belongs", stuck === 0, stuck);
  await p.screenshot({ path: `${out}/motion-ai-window.png` });
  await p.click("[data-testid=opt-share]");
  await sleep(400);
  await p.screenshot({ path: `${out}/motion-ai-window-switch.png` });
  await p.click("[data-testid=opt-share]");
  await p.click("[data-testid=ai-window] button:has-text('Close')");
  await p.click("[data-testid=table-card]");
  await p.waitForSelector("[data-testid=table-window]");
  await sleep(1000);
  await p.screenshot({ path: `${out}/motion-table-window.png` });
  await p.click("[data-testid=table-window] button:has-text('Close')");

  // Dark, and a phone, with things waiting by the box.
  await p.click("[data-testid=table-home] button:has-text('Open General')");
  await p.waitForSelector("[data-testid=attach-button]");
  await p.setInputFiles("[data-testid=attach-input]", [png, note]);
  await p.fill("textarea", "/re");
  await p.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await sleep(700);
  await p.screenshot({ path: `${out}/motion-dark.png` });
  await p.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await p.setViewportSize({ width: 390, height: 844 });
  await sleep(600);
  check("on a phone nothing here pushes the page sideways", await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await p.screenshot({ path: `${out}/motion-phone.png` });
  await p.setViewportSize({ width: 1440, height: 1000 });
  await p.fill("textarea", "");

  // The client's side, as the test client.
  await p.click("[data-testid=client-portal]");
  await p.click("[data-testid=add-test-client]");
  await p.waitForSelector("[data-testid=client-chat]");
  await sleep(700);
  await p.setInputFiles("[data-testid=attach-input]", [png]);
  await p.fill("[data-testid=client-chat] ~ * textarea, textarea", "Can the booking page show the price before I pick a time?");
  await sleep(500);
  await p.screenshot({ path: `${out}/motion-client-box.png` });
  await p.click("button:has-text('Send')");
  await p.waitForSelector("[data-testid=files] img", { timeout: 20000 });
  const turn = await moving(p, "[data-testid=client-chat]");
  await sleep(1200);
  check("on the client's side a turn rises in and settles", (await settled(p, "[data-testid=client-chat] [class*=turn]")) === null, [turn, await settled(p, "[data-testid=client-chat] [class*=turn]")]);
  await p.screenshot({ path: `${out}/motion-client.png` });
  clearInterval(pulse);
} catch (e) {
  results.error = String(e?.stack || e).slice(0, 900);
} finally {
  await browser.close();
  rmSync(stuff, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results).some((v) => v !== "pass") ? 1 : 0);
