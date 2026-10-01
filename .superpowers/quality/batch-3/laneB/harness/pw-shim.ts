/**
 * Lane B verification harness (not part of the app). The mobile e2e suite is
 * pinned to the :3210 origin, the only emulation origin the dev API's CORS
 * allows, and :3210 is already served by another checkout's export. This
 * shim (mapped over "@playwright/test" by harness/tsconfig.json) answers
 * every :3210 request from EXPORT_ROOT instead, with the same path rules as
 * scripts/mobile/serve-export.ts, so the suite runs THIS worktree's build at
 * the origin the API accepts, without touching the shared server.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as real from "../../../../../app/node_modules/@playwright/test/index.js";
import { resolveExportPath } from "../../../../../app/src/lib/export-path";

export * from "../../../../../app/node_modules/@playwright/test/index.js";

const ROOT = process.env.EXPORT_ROOT ?? "";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const base = (real as unknown as { test: typeof import("@playwright/test").test }).test;

export const test = base.extend({
  context: async ({ context }, use) => {
    if (!ROOT) throw new Error("EXPORT_ROOT is required");
    await context.route("http://127.0.0.1:3210/**", (route) => {
      const url = new URL(route.request().url());
      const resolved = resolveExportPath(url.pathname, (rel) => existsSync(path.join(ROOT, rel)));
      const file = path.join(ROOT, resolved.replace(/^\/+/, ""));
      if (!existsSync(file) || !statSync(file).isFile()) {
        return route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
      }
      return route.fulfill({
        status: 200,
        headers: { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" },
        body: readFileSync(file),
      });
    });
    await use(context);
  },
});
