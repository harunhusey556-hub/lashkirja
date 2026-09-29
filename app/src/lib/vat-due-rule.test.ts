import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FP-4 (TF-01, P0): one deadline rule. Koti showed "ALV-ilmoitus 12.11." for
 * the month in progress while Kirjanpito showed the return actually due on
 * 12.10., because Koti called `vatDeadline(` with its own period. Every
 * screen now goes through `nextVatDue` / `vatDueFor` in lib/vat-deadline.ts.
 */
const SRC = path.resolve(__dirname, "..");
const HELPER = path.join(SRC, "lib", "vat-deadline.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "generated" || name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("one VAT deadline rule (FP-4)", () => {
  const files = sourceFiles(SRC);

  it("scans the whole app (population floor)", () => {
    // A broken walk would make the next assertion pass vacuously.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(HELPER);
    expect(readFileSync(HELPER, "utf8")).toMatch(/\bvatDeadline\(/);
  });

  it("calls vatDeadline( nowhere outside lib/vat-deadline.ts", () => {
    const offenders = files.filter(
      (file) => file !== HELPER && /\bvatDeadline\(/.test(readFileSync(file, "utf8"))
    );
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it("Koti and Kirjanpito render the deadline row through the same hook and words", () => {
    for (const rel of ["app/dashboard/DashboardClient.tsx", "app/kirjanpito/page.tsx"]) {
      const text = readFileSync(path.join(SRC, rel), "utf8");
      expect(text, rel).toMatch(/\buseVatDue\(/);
      expect(text, rel).toMatch(/\bvatDueSecondary\(/);
      expect(text, rel).toMatch(/\bvatDueAmount\(/);
      expect(text, rel).toMatch(/\bVAT_ROW_TITLE\b/);
    }
  });
});
