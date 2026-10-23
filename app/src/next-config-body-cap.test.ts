import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_RECEIPT_REQUEST_BYTES,
  MAX_STATEMENT_BYTES,
  MAX_STATEMENT_REQUEST_BYTES,
  MAX_UPLOAD_REQUEST_BYTES,
  RECEIPT_MULTIPART_HEADROOM_BYTES,
} from "./lib/storage";

function proxyCapBytes(): number {
  const source = readFileSync(path.join(__dirname, "..", "next.config.ts"), "utf8");
  const match = source.match(/const MAX_UPLOAD_REQUEST_BYTES = (\d+) \* 1024 \* 1024;/);
  expect(match).not.toBeNull();
  return Number(match![1]) * 1024 * 1024;
}

// next.config.ts cannot import app modules (see the comment there), so the
// proxy body cap is a literal. This keeps it equal to the largest upload limit.
describe("next.config.ts proxy body cap", () => {
  it("matches MAX_UPLOAD_REQUEST_BYTES", () => {
    expect(proxyCapBytes()).toBe(MAX_UPLOAD_REQUEST_BYTES);
  });

  // Beta audit 2026-10: the cap was the receipt's 17 MB while a bank statement may be 20 MB, so
  // the proxy cut a 17-20 MB statement short and the import failed with a 500.
  it("buffers a whole statement and a whole receipt, multipart overhead included", () => {
    const cap = proxyCapBytes();
    expect(cap).toBeGreaterThanOrEqual(MAX_STATEMENT_BYTES + RECEIPT_MULTIPART_HEADROOM_BYTES);
    expect(cap).toBeGreaterThanOrEqual(MAX_STATEMENT_REQUEST_BYTES);
    expect(cap).toBeGreaterThanOrEqual(MAX_RECEIPT_REQUEST_BYTES);
  });

  it("has no relative imports", () => {
    const source = readFileSync(path.join(__dirname, "..", "next.config.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']\.\.?\//);
  });
});
