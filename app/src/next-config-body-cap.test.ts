import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_RECEIPT_REQUEST_BYTES } from "./lib/storage";

// next.config.ts cannot import app modules (see the comment there), so the
// proxy body cap is a literal. This keeps it equal to the receipt limit.
describe("next.config.ts proxy body cap", () => {
  it("matches MAX_RECEIPT_REQUEST_BYTES", () => {
    const source = readFileSync(path.join(__dirname, "..", "next.config.ts"), "utf8");
    const match = source.match(/const MAX_RECEIPT_REQUEST_BYTES = (\d+) \* 1024 \* 1024;/);
    expect(match).not.toBeNull();
    expect(Number(match![1]) * 1024 * 1024).toBe(MAX_RECEIPT_REQUEST_BYTES);
  });

  it("has no relative imports", () => {
    const source = readFileSync(path.join(__dirname, "..", "next.config.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']\.\.?\//);
  });
});
