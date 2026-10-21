// A file an AI names in its answer links to it in the team's repository on GitHub, at what the answer read. No
// database, no AI.
//
//   node tests/e2e/unit-links.mjs

const { githubBase, fileLink } = await import("../../apps/web/lib/file-links.mjs");
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 300)}`; };

check("a GitHub repository written any of three ways is one address", ["https://github.com/team/app", "https://github.com/team/app.git", "git@github.com:team/app.git", "ssh://git@github.com/team/app"]
  .every((r) => githubBase(r) === "https://github.com/team/app"));
check("anything that is not on github.com gets no links", githubBase("https://gitlab.com/team/app") === null && githubBase("file:///C:/x") === null && fileLink(null, "")("src/a.ts") === null);
const at = fileLink("https://github.com/team/app", "longtable/fix-login @ 1a2b3c4");
check("a file links at the commit the answer read", at("src/booking/StaffPicker.tsx") === "https://github.com/team/app/blob/1a2b3c4/src/booking/StaffPicker.tsx");
check("with its line, or lines", at("src/a.ts:42") === "https://github.com/team/app/blob/1a2b3c4/src/a.ts#L42" && at("src/a.ts:4-9") === "https://github.com/team/app/blob/1a2b3c4/src/a.ts#L4-L9");
check("an answer that changed a person's own folder links at the newest", fileLink("https://github.com/team/app", "changed 1 file in Maya's folder")("docs/setup.md") === "https://github.com/team/app/blob/HEAD/docs/setup.md");
check("code that is not a file path is left as code", ["npm test", "v1.2", "useState()", "a && b", "https://x.y/z", ".env", "x"].every((c) => at(c) === null), ["npm test", "v1.2", "useState()"].map(at));
check("never a path that climbs out of the project", at("../secrets.txt") === null && at("src/../../x.ts") === null);
check("code that only looks like a file name is left as code", ["console.log", "React.useState", "Next.js", "node.js", "example.com"].every((c) => at(c) === null), ["console.log", "Next.js"].map(at));
const withRead = fileLink("https://github.com/team/app", "main @ 1a2b3c4", ["package.json", "src/a.ts"]);
check("a file at the top of the project links when the answer read it", withRead("package.json") === "https://github.com/team/app/blob/1a2b3c4/package.json" && withRead("tsconfig.json") === null);
check("work that stayed on one person's computer links nowhere", fileLink("https://github.com/team/app", "changed 1 file on longtable/x @ 1a2b3c4, only on Maya's computer")("src/a.ts") === null);
const { landedBranch, onlyLocal } = await import("../../apps/web/lib/file-links.mjs");
check("a part that landed beside the task's branch is found from its result", landedBranch("changed 2 files on longtable/fix-1a2b3c4d-sam @ 9f8e7d6", "longtable/fix-1a2b3c4d") === "longtable/fix-1a2b3c4d-sam"
  && landedBranch("Done", "longtable/fix") === "longtable/fix" && onlyLocal("changed 1 file on longtable/x @ 1a2b3c4, only on Maya's computer"));

const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
