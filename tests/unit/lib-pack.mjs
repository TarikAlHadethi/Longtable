// Packing the connection the way the npm registry serves it, for the update tests.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// A tar writer, just enough for the test: regular files, and a pax long name when asked.
export function tar(entries) {
  const blocks = [];
  const header = (name, size, type = "0") => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, "utf8");
    h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  for (const e of entries) {
    const data = Buffer.from(e.data);
    if (e.pax) {
      const rec = `path=${e.name}\n`;
      let len = rec.length + 3;
      while (`${len} ${rec}`.length !== len) len = `${len} ${rec}`.length;
      const body = Buffer.from(`${len} ${rec}`);
      blocks.push(header("PaxHeader", body.length, "x"), pad(body));
      blocks.push(header("placeholder", data.length), pad(data));
    } else {
      blocks.push(header(e.name, data.length), pad(data));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// The real connection's own files, as a package of the given version.
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "connect");
export function packageOf(version, extra = []) {
  const entries = [];
  const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else entries.push({ name: `package/${relative(pkgRoot, p).split("\\").join("/")}`, data: readFileSync(p) }); } };
  walk(join(pkgRoot, "bin"));
  walk(join(pkgRoot, "src"));
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  entries.push({ name: "package/package.json", data: JSON.stringify({ ...pkg, version }) });
  return tar([...entries, ...extra]);
}

