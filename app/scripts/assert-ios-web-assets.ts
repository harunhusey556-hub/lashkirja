/** Reject a stale shell or incomplete UI before archiving/packaging an IPA. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const flag = process.argv.indexOf("--public-dir");
const bundled = path.resolve(root, flag < 0 ? "ios/App/App/public" : process.argv[flag + 1]);
const exported = path.join(root, "out");

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? filesIn(file) : [file];
  });
}

for (const relative of ["index.html", "login.html", "kirjanpito.html", "kuitit.html", "_next/static"]) {
  if (!existsSync(path.join(exported, relative)) || !existsSync(path.join(bundled, relative))) {
    throw new Error(`Missing bundled UI: ${relative}. Run build:mobile and cap sync before archiving.`);
  }
}
const expected = filesIn(exported);
let bytes = 0;
for (const file of expected) {
  const relative = path.relative(exported, file);
  const destination = path.join(bundled, relative);
  if (!existsSync(destination)) throw new Error(`Incomplete iOS UI: ${relative}`);
  const source = readFileSync(file);
  const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  if (digest(source) !== digest(readFileSync(destination))) throw new Error(`Stale iOS UI: ${relative}`);
  bytes += source.length;
}
console.log(`Bundled UI verified: ${expected.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB uncompressed. Every file matches out/.`);
