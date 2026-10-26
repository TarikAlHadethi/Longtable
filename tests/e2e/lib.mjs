// Shared helpers for the end-to-end checks. Needs the local stack running (npm run db:start, npm run dev).

import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

// The local keys come from the app's own .env.local, so no key is ever written into the repo.
const localEnv = Object.fromEntries(
  readFileSync(new URL("../../apps/web/.env.local", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
export const APP = process.env.APP_URL || "http://localhost:3000";
export const API = process.env.SUPABASE_URL || localEnv.NEXT_PUBLIC_SUPABASE_URL;
export const KEY = process.env.SUPABASE_PUBLISHABLE_KEY || localEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const MAIL = process.env.MAILPIT_URL || "http://127.0.0.1:54324";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

// Full Claude Code is on by default for a real person, and asks them before it runs anything. The suites written for
// the locked mode run their connections in it; the suites for full Claude Code turn it back on (LONGTABLE_FULL: "on").
process.env.LONGTABLE_FULL ??= "off";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Next's dev build lays its own overlay over the page (a dialog with buttons, such as a notice about the Next version),
// which catches presses and matches the tests' own [role=dialog] lookups. The tests are about the app, so every page
// they open hides it; the production build has no overlay.
const NO_DEV_OVERLAY = `new MutationObserver(() => document.querySelectorAll("nextjs-portal").forEach((p) => p.remove()))
  .observe(document, { childList: true, subtree: true });`;
export async function launch() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => { const c = await newContext(...args); await c.addInitScript(NO_DEV_OVERLAY); return c; };
  return browser;
}

async function codeFor(email) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const first = (await res.json()).messages?.[0];
    if (first) {
      const msg = await (await fetch(`${MAIL}/api/v1/message/${first.ID}`)).json();
      const m = String(msg.Text || msg.HTML || "").match(/\b(\d{6})\b/);
      if (m) return m[1];
    }
    await sleep(250);
  }
  throw new Error(`no code arrived for ${email}`);
}

export async function signIn(page, email) {
  await page.fill("#email", email);
  await page.click("text=Send me a code");
  await page.waitForSelector("#code");
  await page.fill("#code", await codeFor(email));
  await page.click("button:has-text('Sign in')");
}

// Start a table as its owner. Returns the page and the table id.
export async function startTable(browser, email, tableName, myName) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${APP}/start`);
  await signIn(page, email);
  await page.waitForURL(/\/start$/);
  await page.fill("#table", tableName);
  await page.fill("#me", myName);
  await page.click("text=Start the table");
  await page.waitForURL(/\/t\/[0-9a-f-]{36}$/);
  const tableId = page.url().split("/t/")[1];
  // The room opens on the table's home; the checks work in the first chat.
  await page.goto(`${APP}/t/${tableId}?c=general`);
  return { context, page, tableId };
}

export async function inviteLink(ownerPage, role) {
  await ownerPage.click("[data-testid=me-menu]");
  await ownerPage.click("text=Invite people");
  await ownerPage.click(role === "client" ? "text=The client" : "text=A developer");
  const link = (await ownerPage.textContent("[data-testid=invite-link]")).trim();
  await ownerPage.click("[data-testid=invite-close]");
  return link;
}

export async function join(browser, link, email, myName) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  await page.click("text=Sign in to join");
  await signIn(page, email);
  await page.waitForURL(/\/join\//);
  await page.fill("#me", myName);
  await page.click("button:has-text('Join')");
  await page.waitForURL(/\/t\/[0-9a-f-]{36}$/);
  await page.goto(`${page.url()}?c=general`);
  return { context, page };
}

// The session a browser holds, read from its cookie, so the database can be asked directly as that person.
export async function accessToken(context) {
  const cookies = (await context.cookies()).filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name));
  cookies.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  let value = cookies.map((c) => c.value).join("");
  if (value.startsWith("base64-")) value = Buffer.from(value.slice(7), "base64url").toString("utf8");
  return JSON.parse(value).access_token;
}

export async function rest(token, path, init = {}) {
  const res = await fetch(`${API}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

export const rpc = (token, fn, args) => rest(token, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

// Listen on a private live channel as a person, the way their browser does, so a test can check who hears what on
// the wire and not only on screen. Node 20 needs --experimental-websocket for this; Node 22 has WebSocket built in.
export async function listen(token, topic) {
  if (typeof WebSocket === "undefined") throw new Error("listen() needs WebSocket: run node with --experimental-websocket, or Node 22");
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(API, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  await sb.realtime.setAuth(token);
  const heard = [];
  const channel = sb.channel(topic, { config: { private: true } });
  const status = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("TIMED_OUT"), 8000);
    channel.on("broadcast", { event: "*" }, (m) => heard.push(m.payload ?? m))
      .subscribe((s) => { if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR") { clearTimeout(timer); resolve(s); } });
  });
  return {
    status,
    heard,
    stop: async () => { await sb.removeChannel(channel).catch(() => {}); sb.realtime.disconnect(); },
  };
}

// The table's repository, as the owner sets it in Settings, and each person's yes to it in their AI's window. Settings takes only https and ssh addresses, so a test's
// stand-in for GitHub (a bare repository on this computer) is written straight into the local database.
export async function tableRepo(tableId, remotePath) {
  const { execFileSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const url = pathToFileURL(remotePath).href.replace(/'/g, "''");
  execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-c",
    `insert into public.table_code (table_id, repo_url) values ('${tableId}', '${url}') on conflict (table_id) do update set repo_url = excluded.repo_url;
     update public.connections set use_repo = repo_url from public.table_code where table_code.table_id = connections.table_id and connections.table_id = '${tableId}' and connections.revoked_at is null`]);
  return url;
}
