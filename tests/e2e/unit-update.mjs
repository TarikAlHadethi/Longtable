// The connection keeps itself up to date, with no database and no AI: a stand-in npm registry on this computer serves
// versions of the package, good and bad, and the updater takes only the right one, checked, and never a file outside
// its own folder.
//
//   node tests/e2e/unit-update.mjs

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const scratch = mkdtempSync(join(tmpdir(), "longtable-update-"));
process.env.LONGTABLE_HOME = join(scratch, "home");
mkdirSync(process.env.LONGTABLE_HOME, { recursive: true });
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };

import { packageOf, tar } from "./lib-pack.mjs";

const served = {};
const server = createServer((req, res) => {
  const hit = served[req.url];
  if (!hit) { res.writeHead(404); return res.end("{}"); }
  res.writeHead(200, { "content-type": hit.type });
  res.end(hit.body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.LONGTABLE_REGISTRY = base;
const publish = (version, gz, { integrity, tarball, name = "longtable", metaVersion = version } = {}) => {
  const url = tarball ?? `${base}/longtable/-/longtable-${version}.tgz`;
  served[`/longtable/-/longtable-${version}.tgz`] = { type: "application/octet-stream", body: gz };
  served[`/longtable/${version}`] = { type: "application/json", body: JSON.stringify({ name, version: metaVersion, dist: { tarball: url, integrity: integrity ?? `sha512-${createHash("sha512").update(gz).digest("base64")}` } }) };
};

const { newer, untar, keepFile, fetchRelease, installRelease, updateTo, handOffTo, ownVersion, versionOf } = await import("../../packages/connect/src/update.mjs");
const app = join(process.env.LONGTABLE_HOME, "app");

check("versions compare as numbers", newer("0.1.21", "0.1.20") && newer("0.2.0", "0.1.99") && newer("1.0.0", "0.9.9") && !newer("0.1.20", "0.1.20") && !newer("0.1.9", "0.1.10") && !newer("latest", "0.1.0") && !newer("0.1.21-beta", "0.1.20"));
check("a long name is read from its pax header", untar(tar([{ name: "package/src/a-very-long-name.mjs", data: "x", pax: true }]))[0].name === "package/src/a-very-long-name.mjs");
check("only the connection's own parts are kept", keepFile("package/src/run.mjs") === "src/run.mjs" && keepFile("package/package.json") === "package.json"
  && [ "package/../evil.mjs", "package/src/../../evil", "other/src/x.mjs", "package/node_modules/x.js", "package/src/a\\b.mjs", "package//src/x", "package/.npmrc" ].every((n) => keepFile(n) === null));

publish("0.9.1", packageOf("0.9.1", [{ name: "package/../../escaped.txt", data: "nope" }, { name: "package/src/../../../escaped2.txt", data: "nope" }]));
const files = await fetchRelease("0.9.1");
check("a good version is fetched and checked", files.some((f) => f.rel === "bin/longtable.mjs") && files.some((f) => f.rel === "package.json"));
check("files trying to leave the package are dropped", !files.some((f) => /escaped/.test(f.rel)));

const tampered = packageOf("0.9.2");
publish("0.9.2", tampered, { integrity: `sha512-${createHash("sha512").update("something else").digest("base64")}` });
check("a download that does not match the registry's fingerprint is refused", await fetchRelease("0.9.2").then(() => false, (e) => /fingerprint/.test(e.message)));
publish("0.9.3", packageOf("0.9.3"), { tarball: "https://example.com/longtable-0.9.3.tgz" });
check("a package kept anywhere but the registry is refused", await fetchRelease("0.9.3").then(() => false, (e) => /where the registry keeps/.test(e.message)));
publish("0.9.4", packageOf("0.9.5"));
check("a package that says it is another version is refused", await fetchRelease("0.9.4").then(() => false, (e) => /another version/.test(e.message)));
publish("0.9.6", packageOf("0.9.6"), { name: "not-longtable" });
check("an answer about another package is refused", await fetchRelease("0.9.6").then(() => false, (e) => /something else/.test(e.message)));
check("a version not yet published waits", await fetchRelease("0.9.7").then(() => false, (e) => /no longtable 0\.9\.7 yet/.test(e.message)));
check("only plain versions are asked for", await fetchRelease("../../etc").then(() => false, (e) => /not a version/.test(e.message)));

// Putting it in place.
mkdirSync(app, { recursive: true });
const bin = installRelease(files);
check("the new version takes the place of the old copy", versionOf(app) === "0.9.1" && existsSync(bin) && !existsSync(join(process.env.LONGTABLE_HOME, "app-next")));
check("nothing lands outside it", !existsSync(join(scratch, "escaped.txt")) && !existsSync(join(process.env.LONGTABLE_HOME, "escaped.txt")));
check("a connection started from an older copy hands over to the newer one", handOffTo() === bin);
check("never an older version, never the same one", (await updateTo("0.0.1")) === null && (await updateTo(ownVersion())) === null && (await updateTo(null)) === null);
publish("9.9.9", packageOf("9.9.9"));
const moved = await updateTo("9.9.9");
check("updateTo moves to exactly the version asked for", moved && versionOf(app) === "9.9.9");

server.close();
rmSync(scratch, { recursive: true, force: true });
const failed = Object.entries(results).filter(([, v]) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
