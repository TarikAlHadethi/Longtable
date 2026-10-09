// Step 1 check: two people in one room, live.
// Done when a message reaches the other screen in under 0.3 s. Also checks the client wall: a client at the
// same table cannot read one team message, from the page or straight from the database.
//
// Needs the local stack running (npm run db:start, npm run dev).
//   node tests/e2e/step1.mjs

import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

// The local keys come from the app's own .env.local, so no key is ever written into the repo.
const localEnv = Object.fromEntries(
  readFileSync(new URL("../../apps/web/.env.local", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const APP = process.env.APP_URL || "http://localhost:3000";
const API = process.env.SUPABASE_URL || localEnv.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_PUBLISHABLE_KEY || localEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const MAIL = process.env.MAILPIT_URL || "http://127.0.0.1:54324";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROUNDS = 10;
const LIMIT_MS = 300;

const run = Date.now().toString(36);
const emails = { owner: `owner-${run}@example.test`, dev: `dev-${run}@example.test`, client: `client-${run}@example.test` };

async function codeFor(email) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const list = await res.json();
    const first = list.messages?.[0];
    if (first) {
      const msg = await (await fetch(`${MAIL}/api/v1/message/${first.ID}`)).json();
      const m = String(msg.Text || msg.HTML || "").match(/\b(\d{6})\b/);
      if (m) return m[1];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no code arrived for ${email}`);
}

async function signIn(page, email) {
  await page.fill("#email", email);
  await page.click("text=Send me a code");
  await page.waitForSelector("#code");
  await page.fill("#code", await codeFor(email));
  await page.click("button:has-text('Sign in')");
}

// The session the browser holds, read from its cookie, so the database can be asked directly as that person.
async function accessToken(context) {
  const cookies = (await context.cookies()).filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name));
  cookies.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  let value = cookies.map((c) => c.value).join("");
  if (value.startsWith("base64-")) value = Buffer.from(value.slice(7), "base64url").toString("utf8");
  return JSON.parse(value).access_token;
}

async function rest(token, path) {
  const res = await fetch(`${API}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
  return res.json();
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const results = {};
try {
  // The owner starts a table.
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await owner.goto(`${APP}/start`);
  await signIn(owner, emails.owner);
  await owner.waitForURL(/\/start$/);
  await owner.fill("#table", "Booking app");
  await owner.fill("#me", "Maya");
  await owner.click("text=Start the table");
  await owner.waitForURL(/\/t\/[0-9a-f-]{36}$/);
  const tableId = owner.url().split("/t/")[1];

  // An invite link for a developer.
  await owner.click("button:has-text('Invite')");
  await owner.click("text=A developer");
  const devLink = (await owner.textContent("[data-testid=invite-link]")).trim();

  // The developer opens it, signs in and joins.
  const devCtx = await browser.newContext();
  const dev = await devCtx.newPage();
  await dev.goto(devLink);
  await dev.click("text=Sign in to join");
  await signIn(dev, emails.dev);
  await dev.waitForURL(/\/join\//);
  await dev.fill("#me", "Sam");
  await dev.click("button:has-text('Join')");
  await dev.waitForURL(new RegExp(`/t/${tableId}$`));

  // Both see each other as here.
  await dev.waitForSelector("text=Maya", { timeout: 10000 });
  await owner.waitForFunction(() => document.body.innerText.includes("Sam"), null, { timeout: 10000 });
  await owner.waitForSelector("text=The team's chat");
  await dev.waitForSelector("text=The team's chat");

  // The timing: from Enter on one screen to the text on the other.
  const timings = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const nonce = `ping ${i} ${run}`;
    const seen = dev.evaluate((text) => new Promise((resolve) => {
      const check = () => {
        if (document.querySelector("[data-testid=messages]")?.innerText.includes(text)) { resolve(Date.now()); return true; }
        return false;
      };
      if (check()) return;
      const obs = new MutationObserver(() => { if (check()) obs.disconnect(); });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    }), nonce);
    await owner.fill("textarea", nonce);
    const sentAt = Date.now();
    await owner.press("textarea", "Enter");
    timings.push((await seen) - sentAt);
  }
  if (process.env.SCREENSHOTS) {
    await owner.setViewportSize({ width: 1280, height: 800 });
    await owner.screenshot({ path: `${process.env.SCREENSHOTS}/room-owner.png` });
    await dev.setViewportSize({ width: 390, height: 844 });
    await dev.screenshot({ path: `${process.env.SCREENSHOTS}/room-phone.png` });
  }
  timings.sort((a, b) => a - b);
  results.latencyMs = { median: timings[Math.floor(timings.length / 2)], max: timings[timings.length - 1], all: timings };
  results.latencyPass = timings[timings.length - 1] < LIMIT_MS;

  // The client wall: the client joins the same table and must not see one team message.
  await owner.click("button:has-text('Invite')");
  await owner.click("button:has-text('Invite')");
  await owner.click("text=The client");
  const clientLink = (await owner.textContent("[data-testid=invite-link]")).trim();
  const clientCtx = await browser.newContext();
  const client = await clientCtx.newPage();
  await client.goto(clientLink);
  await client.click("text=Sign in to join");
  await signIn(client, emails.client);
  await client.waitForURL(/\/join\//);
  await client.fill("#me", "Dr. Ruiz");
  await client.click("button:has-text('Join')");
  await client.waitForURL(new RegExp(`/t/${tableId}$`));
  const clientPage = await client.textContent("body");
  const clientToken = await accessToken(clientCtx);
  const devToken = await accessToken(devCtx);
  const clientRows = await rest(clientToken, `messages?select=id,body&table_id=eq.${tableId}`);
  const devRows = await rest(devToken, `messages?select=id&table_id=eq.${tableId}`);
  const forged = await fetch(`${API}/rest/v1/messages`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${clientToken}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ table_id: tableId, member_id: "00000000-0000-0000-0000-000000000000", body: "forged" }),
  });
  results.clientWall = {
    pageShowsNoTeamChat: !clientPage.includes("ping 1"),
    clientReadsRows: Array.isArray(clientRows) ? clientRows.length : clientRows,
    teamReadsRows: Array.isArray(devRows) ? devRows.length : devRows,
    clientWriteStatus: forged.status,
  };
  results.clientWallPass = results.clientWall.pageShowsNoTeamChat && results.clientWall.clientReadsRows === 0
    && results.clientWall.teamReadsRows === ROUNDS && forged.status >= 400;
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
process.exit(results.latencyPass && results.clientWallPass ? 0 : 1);
