import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// `npm audit` needs the network, so it cannot run in this suite. The production
// advisories closed in beta round 1 (R3-DEPS) are pinned here as the releases they
// affect: a lockfile regenerated from an old cache, or an install that resolves one
// nested copy back to a vulnerable release, fails here instead of at the next audit.
type LockEntry = { version?: string; dev?: boolean };

const appRoot = path.join(__dirname, "..");
const lock = JSON.parse(readFileSync(path.join(appRoot, "package-lock.json"), "utf8")) as {
  packages: Record<string, LockEntry>;
};

// Every copy npm placed in the production tree, nested ones included.
function copiesOf(name: string): { where: string; version: string }[] {
  const tail = `node_modules/${name}`;
  return Object.entries(lock.packages)
    .filter(([key, entry]) => (key === tail || key.endsWith(`/${tail}`)) && !entry.dev && entry.version)
    .map(([key, entry]) => ({ where: key, version: entry.version as string }));
}

// Prerelease tags are dropped: every bound below is a plain release.
function parts(version: string): number[] {
  return version.split("-")[0].split(".").map(Number);
}

function compare(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// from is the first vulnerable release, fixedIn the first release that closes the
// advisories (each entry is the highest fix among the advisories on that package).
const affected = [
  { name: "next", from: "16.0.0", fixedIn: "16.4.1", ids: "GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r, GHSA-673q-mjm6-r5xr" },
  { name: "prisma", from: "7.0.0", fixedIn: "7.10.1", ids: "via @prisma/config, deepmerge-ts and mysql2" },
  { name: "@prisma/config", from: "7.0.0", fixedIn: "7.10.1", ids: "via deepmerge-ts" },
  { name: "deepmerge-ts", from: "0.0.0", fixedIn: "8.0.0", ids: "GHSA-ggr8-5vv4-36mx" },
  { name: "mysql2", from: "0.0.0", fixedIn: "3.23.1", ids: "GHSA-3f6p-5ww8-9rcr, GHSA-rgwj-5xj2-c3m3" },
  { name: "fast-uri", from: "3.0.0", fixedIn: "3.1.8", ids: "GHSA-5jgf-p345-68v8 and five more" },
  { name: "brace-expansion", from: "4.0.0", fixedIn: "5.0.12", ids: "GHSA-q2hr-2g5m-vwhr and two more" },
  { name: "source-map-js", from: "1.0.0", fixedIn: "1.2.2", ids: "GHSA-68fv-2mgg-jv7q" },
  { name: "nanoid", from: "0.0.0", fixedIn: "3.3.18", ids: "GHSA-2v37-7h3g-55p8" },
  { name: "nanoid", from: "4.0.0", fixedIn: "5.1.6", ids: "GHSA-2v37-7h3g-55p8" },
  { name: "ip-address", from: "0.0.0", fixedIn: "10.7.4", ids: "GHSA-rpw4-54j3-4h4q and four more" },
  { name: "@xmldom/xmldom", from: "0.7.0", fixedIn: "0.8.15", ids: "GHSA-93r5-fhx6-vmg9 and twelve more" },
  { name: "@xmldom/xmldom", from: "0.9.0", fixedIn: "0.9.12", ids: "GHSA-93r5-fhx6-vmg9 and twelve more" },
  { name: "@capacitor/ios", from: "8.0.0", fixedIn: "8.4.3", ids: "GHSA-rvm3-566m-v7fv" },
  { name: "@capacitor/ios", from: "8.5.0", fixedIn: "8.5.1", ids: "GHSA-rvm3-566m-v7fv" },
];

describe("package-lock.json", () => {
  it("finds the packages it checks", () => {
    // An empty answer would let every check below pass on a lock it failed to read.
    expect(copiesOf("next")).toHaveLength(1);
    expect(copiesOf("@prisma/client")).toHaveLength(1);
    expect(copiesOf("@capacitor/ios")).toHaveLength(1);
  });

  it.each(affected)("keeps $name out of $from up to $fixedIn ($ids)", ({ name, from, fixedIn }) => {
    const vulnerable = copiesOf(name).filter(
      ({ version }) => compare(version, from) >= 0 && compare(version, fixedIn) < 0
    );
    expect(vulnerable).toEqual([]);
  });

  it("keeps prisma, @prisma/client and the libSQL adapter on one release", () => {
    // They ship together; a mixed set fails at runtime, not at install.
    const versions = ["prisma", "@prisma/client", "@prisma/adapter-libsql"].map((name) => {
      const [only] = copiesOf(name);
      return only?.version;
    });
    expect(new Set(versions).size).toBe(1);
    expect(versions[0]).toMatch(/^7\./);
  });

  it("keeps the committed Swift package pin on the locked @capacitor/ios release", () => {
    // `cap sync ios` writes this pin from the npm release, and the pin is what
    // fetches the native code the advisory is about.
    const manifest = readFileSync(path.join(appRoot, "ios", "App", "CapApp-SPM", "Package.swift"), "utf8");
    const pinned = manifest.match(/capacitor-swift-pm\.git",\s*exact:\s*"([^"]+)"/);
    expect(pinned).not.toBeNull();
    expect(pinned![1]).toBe(copiesOf("@capacitor/ios")[0].version);
  });
});
