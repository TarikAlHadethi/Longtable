// Step 6 check, GitHub events: the owner connects a repo from Settings; deliveries signed with the table's secret
// put short lines in General, live (a push to main, a pull request opened and merged, a failed CI run); a push to
// another branch is ignored; a delivery with a wrong signature is refused and posts nothing; the secret is
// unreadable; only the owner connects; the client sees none of it.
//
//   node tests/e2e/step6-github.mjs

import { createHmac } from "node:crypto";
import { APP, accessToken, inviteLink, join, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const tableId = owner.tableId;
  const dev = await join(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  const client = await join(browser, await inviteLink(owner.page, "client"), `client-${run}@example.test`, "Dr. Ruiz");

  await owner.page.goto(`${APP}/t/${tableId}/settings`);
  await owner.page.click("button:has-text('Connect a repo')");
  const url = await owner.page.inputValue("[data-testid=github-url]");
  const secret = await owner.page.inputValue("[data-testid=github-secret]");
  check("Settings gives a webhook URL and a secret", url.endsWith(`/api/github/${tableId}`) && /^[0-9a-f]{48}$/.test(secret), url);

  const deliver = async (event, body, key = secret) => {
    const text = JSON.stringify(body);
    const sig = "sha256=" + createHmac("sha256", key).update(text).digest("hex");
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": event, "X-Hub-Signature-256": sig }, body: text });
    return res.status;
  };
  const repo = { full_name: "maya/booking-app", default_branch: "main" };
  const statuses = {
    ping: await deliver("ping", { zen: "Keep it simple.", repository: repo }),
    push: await deliver("push", { ref: "refs/heads/main", repository: repo, pusher: { name: "Sam" },
      commits: [{ id: "a" }, { id: "b" }], head_commit: { message: "Fix booking dates\n\nLonger body" } }),
    branch: await deliver("push", { ref: "refs/heads/feature-x", repository: repo, pusher: { name: "Sam" }, commits: [{ id: "c" }], head_commit: { message: "WIP" } }),
    opened: await deliver("pull_request", { action: "opened", repository: repo, pull_request: { number: 12, title: "Waiting list", user: { login: "sam" } } }),
    merged: await deliver("pull_request", { action: "closed", repository: repo, pull_request: { number: 12, title: "Waiting list", merged: true, user: { login: "sam" } } }),
    ci: await deliver("workflow_run", { action: "completed", repository: repo, workflow_run: { name: "tests", head_branch: "main", conclusion: "failure" } }),
    forged: await deliver("push", { ref: "refs/heads/main", repository: repo, pusher: { name: "Mallory" }, commits: [{ id: "x" }], head_commit: { message: "Forged line" } }, "not-the-secret"),
  };
  results.statuses = statuses;
  check("signed deliveries are taken, a forged one refused", ["ping", "push", "branch", "opened", "merged", "ci"].every((k) => statuses[k] === 204) && statuses.forged === 401,
    JSON.stringify(statuses));

  await dev.page.waitForFunction(() => document.querySelectorAll("[data-github]").length >= 5, null, { timeout: 10000 }).catch(() => {});
  const lines = await dev.page.$$eval("[data-github]", (els) => els.map((e) => e.textContent));
  results.lines = lines;
  const all = lines.join(" | ");
  check("the lines land in General, live", lines.length === 5 && all.includes("GitHub is connected to maya/booking-app")
    && all.includes("Sam pushed 2 commits to main: Fix booking dates") && all.includes("sam opened pull request #12: Waiting list")
    && all.includes("Pull request #12 was merged: Waiting list") && all.includes("CI failed on main: tests"), all);
  check("another branch and the forged one post nothing", !all.includes("WIP") && !all.includes("Forged"), all);

  const [ownerToken, devToken, clientToken] = await Promise.all([owner.context, dev.context, client.context].map(accessToken));
  const hooks = await rest(ownerToken, `github_hooks?select=secret`);
  const devConnect = await rpc(devToken, "connect_github", { t: tableId });
  const clientReads = (await rest(clientToken, `messages?select=id&table_id=eq.${tableId}&kind=eq.github`)).body.length;
  check("the secret is unreadable, only the owner connects, the client sees none of it",
    hooks.status >= 400 && devConnect.status >= 400 && clientReads === 0, JSON.stringify({ hooks: hooks.status, dev: devConnect.status, clientReads }));
  await owner.page.reload();
  const shown = await owner.page.textContent("[data-testid=github-status]");
  check("Settings shows the repo it is connected to", shown.includes("maya/booking-app"), shown);
} finally {
  await browser.close();
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
