// Attachments, a person's own commands behind "/", and the windows every card on the table opens.
//
//   node --experimental-websocket tests/e2e/step23-more-hands.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accessToken, inviteLink, join as joinTable, launch, rest, rpc, startTable } from "./lib.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bin = join(repoRoot, "packages", "connect", "bin", "longtable.mjs");
const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };
const savedSignIn = join(homedir(), ".longtable", "secrets", "claude-token.bin");
if (!existsSync(savedSignIn)) throw new Error("No saved Claude sign-in on this computer.");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// The project: a bare repository standing in for GitHub, and a folder cloned from it.
const scratch = mkdtempSync(join(tmpdir(), "longtable-work-"));
const remote = join(scratch, "remote.git");
const project = join(scratch, "project");
git(scratch, "init", "-q", "--bare", "-b", "main", remote);
git(scratch, "clone", "-q", remote, project);
writeFileSync(join(project, "greet.js"), 'export const greeting = "hello";\n');
writeFileSync(join(project, "README.md"), "# Greeter\n\nOne file, greet.js, that exports a greeting.\n");
git(project, "add", "-A");
git(project, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "start");
git(project, "push", "-q", "origin", "HEAD:main");

function home() {
  const dir = mkdtempSync(join(tmpdir(), "longtable-home-"));
  mkdirSync(join(dir, "secrets"), { recursive: true });
  copyFileSync(savedSignIn, join(dir, "secrets", "claude-token.bin"));
  return dir;
}

async function connect(page, dir) {
  await page.click("[data-testid=me-menu]");
  await page.click("button:has-text('Connect my AI')");
  await page.click("[data-testid=pick-claude]");
  await page.click("text=It is only on my computer");
  const message = await page.locator("[data-testid=connect-message]").textContent();
  const [, code, app] = message.match(/connect ([0-9A-F]{20}) --app (\S+)/);
  const env = { ...process.env, LONGTABLE_HOME: dir, LONGTABLE_MODEL: "haiku" };
  const r = spawnSync(process.execPath, [bin, "connect", code, "--app", app, "--repo", project, "--no-autostart", "--no-run"], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  await page.locator("[role=dialog] button").last().click();
  return spawn(process.execPath, [bin, "run"], { env, stdio: "ignore", windowsHide: true });
}

// Her own commands, on her own computer; and things to attach.
const claudeHome = mkdtempSync(join(tmpdir(), "longtable-claude-"));
mkdirSync(join(claudeHome, "commands"), { recursive: true });
mkdirSync(join(claudeHome, "skills", "house-style"), { recursive: true });
writeFileSync(join(claudeHome, "commands", "signoff.md"), "---\ndescription: Answer, then sign off the house way\n---\nAnswer what was asked in one or two sentences. Then end your answer with this exact sign-off on its own line: ZUCCHINI-5\n\nWhat was asked: $ARGUMENTS\n");
writeFileSync(join(claudeHome, "skills", "house-style", "SKILL.md"), "---\nname: house-style\ndescription: How this team writes\n---\nWrite plainly.\n");
const stuff = mkdtempSync(join(tmpdir(), "longtable-stuff-"));
const note = join(stuff, "room note.txt");
writeFileSync(note, "The planning meeting is in room LEMON-31 on Thursday.");
const png = join(stuff, "dot.png");
writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

const homes = [home()];
const runners = [];
const browser = await launch();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Greeter", "Maya");
  const dev = await joinTable(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  const elena = await joinTable(browser, await inviteLink(owner.page, "client"), `elena-${run}@example.test`, "Elena Ruiz");
  const token = await accessToken(owner.context);
  const devToken = await accessToken(dev.context);
  const elenaToken = await accessToken(elena.context);
  process.env.LONGTABLE_CLAUDE_HOME = claudeHome;
  runners.push(await connect(owner.page, homes[0]));
  await owner.page.waitForFunction(() => document.querySelectorAll("[data-ai='intro']").length >= 1, null, { timeout: 180000 });
  const p = owner.page;

  // Every card on the table opens a window.
  await p.click("[data-testid=home]");
  await p.click("[data-testid=table-home] [data-seat-ai=claude]");
  await p.waitForSelector("[data-testid=ai-window]");
  const aiText = await p.textContent("[data-testid=ai-window]");
  check("her AI's card opens its window, with what it may do", /Your Claude/.test(aiText) && /Open what I point at/.test(aiText) && /Share it with the other AIs/.test(aiText), aiText.slice(0, 300));
  await p.click("[data-testid=opt-share]");
  await wait(800);
  const conns = (await rest(token, `connections?select=open_paths,share_paths,commands&table_id=eq.${owner.tableId}&revoked_at=is.null`)).body;
  check("a switch in it is kept", conns[0]?.open_paths === true && conns[0]?.share_paths === false, JSON.stringify(conns.map((c) => [c.open_paths, c.share_paths])));
  check("the table knows her commands and skills by name, never what is in them", conns[0]?.commands?.some((c) => c.name === "signoff" && /sign off/.test(c.about)) && conns[0].commands.some((c) => c.name === "house-style" && c.kind === "skill")
    && !JSON.stringify(conns[0].commands).includes("ZUCCHINI"), JSON.stringify(conns[0]?.commands));
  await p.click("[data-testid=ai-window] button:has-text('Close')");
  await dev.page.click("[data-testid=home]");
  await dev.page.click("[data-testid=table-home] [data-seat-ai=claude]");
  await dev.page.waitForSelector("[data-testid=ai-window]");
  check("someone else can look at her AI but not change it", (await dev.page.locator("[data-testid=opt-open]").count()) === 0 && /Only Maya can change/.test(await dev.page.textContent("[data-testid=ai-window]")));
  await dev.page.click("[data-testid=ai-window] button:has-text('Close')");
  await p.click("[data-testid=table-card]");
  await p.waitForSelector("[data-testid=table-window]");
  check("the table's card opens its window", /Speaks through/.test(await p.textContent("[data-testid=table-window]")) && /Your Claude/.test(await p.textContent("[data-testid=table-window]")));
  await p.click("[data-testid=table-window] button:has-text('Close')");
  await p.click("[data-testid=table-home] [data-person='Sam'] button");
  await p.waitForSelector("[data-testid=person-window]");
  check("a person's picture opens their window", /Sam/.test(await p.textContent("[data-testid=person-window]")));
  await p.click("[data-testid=person-window] button:has-text('Close')");

  // Attaching: a picture and a file on one message. Everyone on the team sees them.
  await p.click("[data-testid=table-home] button:has-text('Open General')");
  await dev.page.click("[data-testid=table-home] button:has-text('Open General')");
  const ais = () => p.locator("[data-ai='true']").count();
  await p.setInputFiles("[data-testid=attach-input]", [png, note]);
  await p.waitForSelector("[data-testid=attach-tray]");
  check("what is attached waits by the box", /dot\.png/.test(await p.textContent("[data-testid=attach-tray]")) && /room note\.txt/.test(await p.textContent("[data-testid=attach-tray]")));
  let n = await ais();
  await p.fill("textarea", "which room is the planning meeting in? it is in the note i attached");
  await p.click("button:has-text('Send')");
  await p.waitForSelector("[data-testid=files] img", { timeout: 20000 });
  check("her message shows the picture and the file", (await p.locator("[data-testid=files] img").count()) === 1 && /room note\.txt/.test(await p.textContent("[data-testid=files]")));
  await dev.page.waitForSelector("[data-testid=files] img", { timeout: 20000 }).then(() => check("a teammate sees them too, live", true)).catch(() => check("a teammate sees them too, live", false));
  await p.waitForFunction((k) => document.querySelectorAll("[data-ai='true']").length > k, n, { timeout: 300000 });
  await wait(800);
  const a1 = await p.locator("[data-ai='true']").last().textContent();
  results.a1 = a1.slice(0, 300);
  check("her AI read what was attached", /LEMON-31/.test(a1), a1.slice(0, 300));

  // Whose file is whose.
  const files = (await rest(token, `attachments?select=id,path,name,kind,member_id&table_id=eq.${owner.tableId}`)).body;
  check("the rows say what each is", files.length === 2 && files.some((f) => f.kind === "image") && files.some((f) => f.kind === "file"), JSON.stringify(files));
  check("nobody reads where an AI fetches from", (await rest(token, "attachment_links?select=url")).body.length === 0 && (await rest(devToken, "attachment_links?select=url")).body.length === 0);
  check("a client sees nothing of the team's attachments", (await rest(elenaToken, `attachments?select=id&table_id=eq.${owner.tableId}`)).body.length === 0);
  const general = (await rest(token, `chats?select=id&table_id=eq.${owner.tableId}&is_general=eq.true`)).body[0].id;
  const steal = await rpc(devToken, "send_with_files", { c: general, body: "mine now", files: [{ path: files[0].path, name: "x", mime: "text/plain", size: 1, url: "http://x/storage/v1/object/sign/attachments/" + files[0].path + "?token=1" }] });
  check("nobody can attach a file out of someone else's folder", steal.status >= 400, JSON.stringify(steal.body));

  // A client attaches a screenshot: it reaches the team on the request.
  await elena.page.setInputFiles("[data-testid=attach-input]", [png]);
  await elena.page.fill("[aria-label='Ask the team']", "the button looks wrong, see the picture");
  await elena.page.click("button:has-text('Send')");
  await elena.page.waitForSelector("[data-testid=files] img", { timeout: 20000 }).then(() => check("the client sees her own picture on her request", true)).catch(() => check("the client sees her own picture on her request", false));
  await p.waitForFunction(() => document.querySelectorAll("[data-request] [data-testid=files] img").length >= 1, null, { timeout: 20000 })
    .then(() => check("and the team sees it on her request", true)).catch(() => check("and the team sees it on her request", false));

  // "/" offers her own commands, and running one runs it on her own AI.
  await p.fill("textarea", "/");
  await p.waitForSelector("[data-testid=slash-menu]");
  const menu = await p.textContent("[data-testid=slash-menu]");
  check("typing / shows her own commands and skills", /\/signoff/.test(menu) && /\/house-style/.test(menu), menu);
  await p.keyboard.type("sig");
  await p.keyboard.press("Enter");
  check("picking one puts it in the box", (await p.inputValue("textarea")) === "/signoff ");
  n = await ais();
  await p.keyboard.type("what does greet.js export?");
  await p.click("button:has-text('Send')");
  await p.waitForFunction((k) => document.querySelectorAll("[data-ai='true']").length > k, n, { timeout: 300000 });
  await wait(800);
  const a2 = await p.locator("[data-ai='true']").last().textContent();
  results.a2 = a2.slice(0, 300);
  check("her command ran on her own AI", /ZUCCHINI-5/.test(a2) && /greeting/i.test(a2), a2.slice(0, 300));
  await dev.page.fill("textarea", "/");
  await wait(600);
  check("someone with no AI of their own is offered no commands", (await dev.page.locator("[data-testid=slash-menu]").count()) === 0);
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  for (const r of runners) r.kill();
  await browser.close();
  for (const h of [...homes, scratch, claudeHome, stuff]) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
}
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results.checks).some((v) => v !== "pass") ? 1 : 0);
