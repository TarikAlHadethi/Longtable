// What the check before a commit stops and what it lets through, with no git involved: key shapes, written-out
// passwords, real .env files and the folders that never leave this computer. Every key here is put together from
// pieces, so this file passes the check itself.
//
//   node tests/e2e/unit-scan.mjs

import { lineTrouble, looksReal, pathTrouble, scanDiff } from "../../tools/scan-staged.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else { fail++; console.log(`FAIL ${name} ${JSON.stringify(detail ?? "")}`.slice(0, 500)); } };
const NL = String.fromCharCode(10);
const body = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3dEf6hIj9k";

const keys = {
  "an Anthropic key": "sk-" + "ant-api03-" + body,
  "an OpenAI key": "sk-" + "proj-" + body,
  "a Supabase secret key": "sb_" + "secret_" + body,
  "a signed token": "ey" + "JhbGciOiJIUzI1NiJ9" + "." + "ey" + "Jyb2xlIjoic2VydmljZV9yb2xlIn0" + "." + body,
  "a GitHub token": "gh" + "p_" + body.slice(0, 36),
  "an npm token": "np" + "m_" + body.slice(0, 36),
  "a Resend key": "re" + "_Ab3dEf6h_" + body.slice(0, 24),
  "an AWS key id": "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  "a private key": "-----BEGIN RSA " + "PRIVATE KEY-----",
  "a sign-in inside an address": "postgres://postgres:" + "Ab3dEf6hIj9k" + "@db.example.test:5432/postgres",
};
for (const [name, key] of Object.entries(keys)) {
  check(`${name} is stopped`, lineTrouble(`const k = "${key}";`) !== "", lineTrouble(`const k = "${key}";`));
}

check("a written-out password in code is stopped", lineTrouble(`const password = "${body.slice(0, 20)}";`) !== "");
check("a written-out secret in an env file is stopped", lineTrouble(`RESEND_API_KEY=${body.slice(0, 24)}`) !== "");
check("a secret name with no value is let through", lineTrouble("RESEND_API_KEY=") === "");
check("the publishable key is let through", lineTrouble(`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${body.slice(0, 24)}`) === "");
check("a stand-in value is let through", lineTrouble(`const password = "your-password-here-123";`) === "" && lineTrouble("API_KEY=<paste yours here>") === "");
check("a value read from the environment is let through", lineTrouble("const token = process.env.ANTHROPIC_API_KEY;") === "" && lineTrouble("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}") === "");
check("ordinary code about tokens is let through", lineTrouble(`const token = searchParams.get("token");`) === "" && lineTrouble(`if (!token) return notFound();`) === "");
check("a sentence is not a password", !looksReal("this is just 12 words") && !looksReal("aaaaaaaaaaaa1"));
check("a made-up key marked as fake is let through", lineTrouble(`const k = "${keys["an Anthropic key"]}"; // scan:fake`) === "");

check("a real .env file is stopped", pathTrouble("apps/web/.env.local") !== "" && pathTrouble(".env") !== "" && pathTrouble("apps/web/.env.production") !== "");
check("an example .env file is let through", pathTrouble("apps/web/.env.example") === "");
check("the local notes and settings are stopped", pathTrouble("CLAUDE.md") !== "" && pathTrouble(".claude/settings.json") !== "" && pathTrouble("sweep-notes/report.md") !== "" && pathTrouble("private/draft.md") !== "");
check("a key file is stopped", pathTrouble("certs/server.pem") !== "" && pathTrouble("keys/id_ed25519") !== "");
check("an ordinary file is let through", pathTrouble("apps/web/app/page.tsx") === "" && pathTrouble("tests/e2e/step1.mjs") === "");

const diff = [
  "diff --git a/lib/a.ts b/lib/a.ts",
  "--- a/lib/a.ts",
  "+++ b/lib/a.ts",
  "@@ -3,1 +7,2 @@",
  `-const old = "${keys["a GitHub token"]}";`,
  "+const fine = 1;",
  `+const k = "${keys["a GitHub token"]}";`,
].join(NL);
const found = scanDiff(diff);
check("only added lines are read, and the place is named", found.length === 1 && found[0].path === "lib/a.ts" && found[0].line === 8, found);
check("what was found is never printed whole", found.length === 1 && !found[0].text.includes(keys["a GitHub token"]), found);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
