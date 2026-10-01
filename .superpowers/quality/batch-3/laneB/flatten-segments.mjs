// Windows-only emulation fix-up, never used for the IPA (CI builds on macOS).
// On Windows, Next's export writes nested segment prefetch files as
// "__next.a/b.txt" (the segment path keeps a backslash that path.join turns
// into a directory) while the client asks for "__next.a.b.txt". Copies each
// nested file to the dotted name the client requests, so the local export
// prefetches like the macOS-built IPA does. Usage: node flatten-segments.mjs <out dir>
import { copyFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
const root = process.argv[2];
let copied = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    if (name.startsWith("__next.")) flatten(dir, full, name);
    else walk(full);
  }
}
function flatten(parent, dir, prefix) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) flatten(parent, full, `${prefix}.${name}`);
    else if (name.endsWith(".txt")) {
      const dest = path.join(parent, `${prefix}.${name}`);
      if (!existsSync(dest)) {
        copyFileSync(full, dest);
        copied++;
      }
    }
  }
}
walk(root);
console.log(`flattened ${copied} segment files`);
