// Probe, not a check: how long the database and realtime path alone take, with no page in between. A message is
// written over REST and timed until its broadcast reaches a listener on the team channel.
//
//   node --experimental-websocket tests/e2e/probe-latency.mjs

import { accessToken, launch, listen, rest, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const browser = await launch();
try {
  const owner = await startTable(browser, `probe-${run}@example.test`, "Latency probe", "Maya");
  const token = await accessToken(owner.context);
  const me = (await rest(token, `members?select=id&table_id=eq.${owner.tableId}`)).body[0].id;
  const chat = (await rest(token, `chats?select=id&table_id=eq.${owner.tableId}&is_general=eq.true`)).body[0].id;
  await owner.page.close();
  const ear = await listen(token, `team:${owner.tableId}`);
  const times = [];
  for (let i = 0; i < 12; i++) {
    const body = `probe ${i} ${run}`;
    const sent = performance.now();
    await rest(token, "messages", { method: "POST", body: JSON.stringify({ table_id: owner.tableId, chat_id: chat, member_id: me, body }) });
    const wrote = performance.now() - sent;
    while (!ear.heard.some((m) => m.record?.body === body) && performance.now() - sent < 3000) await sleep(2);
    times.push({ total: Math.round(performance.now() - sent), rest: Math.round(wrote) });
    await sleep(150);
  }
  await ear.stop();
  const totals = times.map((t) => t.total).sort((a, b) => a - b);
  console.log(JSON.stringify({ status: ear.status, median: totals[Math.floor(totals.length / 2)], all: times }, null, 1));
} finally {
  await browser.close();
}
