// Step 1 check: two people in one room, live.
// Done when a message reaches the other screen in under 0.3 s. Also checks the client wall: a client at the
// same table cannot read one team message, from the page or straight from the database.
//
//   node tests/e2e/step1.mjs

import { API, KEY, accessToken, inviteLink, join, launch, rest, startTable } from "./lib.mjs";

const ROUNDS = 10;
const LIMIT_MS = 300;
const run = Date.now().toString(36);
const results = {};

const live = (page) => page.waitForFunction(() => !document.body.innerText.includes("Connecting"), null, { timeout: 10000 });

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const tableId = owner.tableId;
  const dev = await join(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");

  // Both see each other, and both are connected.
  await dev.page.waitForSelector("text=Maya", { timeout: 10000 });
  await owner.page.waitForFunction(() => document.body.innerText.includes("Sam"), null, { timeout: 10000 });
  await live(owner.page);
  await live(dev.page);

  // The timing: from Enter on one screen to the text on the other.
  const timings = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const nonce = `ping ${i} ${run}`;
    const seen = dev.page.evaluate((text) => new Promise((resolve) => {
      const check = () => {
        if (document.querySelector("[data-testid=messages]")?.innerText.includes(text)) { resolve(Date.now()); return true; }
        return false;
      };
      if (check()) return;
      const obs = new MutationObserver(() => { if (check()) obs.disconnect(); });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    }), nonce);
    await owner.page.fill("textarea", nonce);
    const sentAt = Date.now();
    await owner.page.press("textarea", "Enter");
    timings.push((await seen) - sentAt);
  }
  if (process.env.SCREENSHOTS) {
    await owner.page.setViewportSize({ width: 1280, height: 800 });
    await owner.page.screenshot({ path: `${process.env.SCREENSHOTS}/room-owner.png` });
    await dev.page.setViewportSize({ width: 390, height: 844 });
    await dev.page.screenshot({ path: `${process.env.SCREENSHOTS}/room-phone.png` });
  }
  timings.sort((a, b) => a - b);
  results.latencyMs = { median: timings[Math.floor(timings.length / 2)], max: timings[timings.length - 1], all: timings };
  results.latencyPass = timings[timings.length - 1] < LIMIT_MS;

  // The client wall: the client joins the same table and must not see one team message.
  const client = await join(browser, await inviteLink(owner.page, "client"), `client-${run}@example.test`, "Dr. Ruiz");
  const clientPage = await client.page.textContent("body");
  const clientToken = await accessToken(client.context);
  const devToken = await accessToken(dev.context);
  const clientRows = await rest(clientToken, `messages?select=id,body&table_id=eq.${tableId}`);
  const devRows = await rest(devToken, `messages?select=id&table_id=eq.${tableId}`);
  const forged = await fetch(`${API}/rest/v1/messages`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${clientToken}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ table_id: tableId, member_id: "00000000-0000-0000-0000-000000000000", body: "forged" }),
  });
  results.clientWall = {
    pageShowsNoTeamChat: !clientPage.includes("ping 1"),
    clientReadsRows: Array.isArray(clientRows.body) ? clientRows.body.length : clientRows.status,
    teamReadsRows: Array.isArray(devRows.body) ? devRows.body.length : devRows.status,
    clientWriteStatus: forged.status,
  };
  results.clientWallPass = results.clientWall.pageShowsNoTeamChat && results.clientWall.clientReadsRows === 0
    && results.clientWall.teamReadsRows === ROUNDS && forged.status >= 400;
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
process.exit(results.latencyPass && results.clientWallPass ? 0 : 1);
