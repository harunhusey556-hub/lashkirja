import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..");

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "ci-autopilot" || entry.name === "generated") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Every button text the iOS simulator autopilot looks for (run.ts). When the app
// renames one of them the autopilot stops waiting for it, so the rename has to
// reach run.ts too.
const AUTOPILOT_LABELS = ["Kirjaa ulos", "Jatka", "Hyväksy ja aloita", "Takaisin", "Neljännesvuosittain", "Lisää", "Avustaja", "Sulje"];

describe("ci-autopilot labels", () => {
  const sources = walk(SRC, []).map((file) => fs.readFileSync(file, "utf8"));

  for (const label of AUTOPILOT_LABELS) {
    it(`the app still shows "${label}"`, () => {
      expect(sources.some((src) => src.includes(label))).toBe(true);
    });
  }

  it("run.ts searches only labels listed here", () => {
    const run = fs.readFileSync(path.join(__dirname, "run.ts"), "utf8");
    const used = [...run.matchAll(/buttonWithText\([^,]+,\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const label of used) expect(AUTOPILOT_LABELS, label).toContain(label);
    expect(used.length).toBeGreaterThan(0);
  });
});
