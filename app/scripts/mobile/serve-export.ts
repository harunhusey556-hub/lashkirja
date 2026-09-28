/**
 * Serves a static export the same way the native Capacitor router will
 * (Router.swift:19-28 serves /index.html for every extensionless path; the
 * plan's Task 12 ports resolveExportPath() to Swift). Used for local
 * emulation (playwright.mobile.config.ts) and by nothing else -- Capacitor
 * on-device never runs a Node server. Node's built-in `http` only, no new
 * dependency (parallel-rules.md rule 3).
 *
 * Usage: tsx scripts/mobile/serve-export.ts --port 3210 --root out
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveExportPath } from "../../src/lib/export-path";

function argValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index === -1 || index === args.length - 1 ? fallback : args[index + 1];
}

const PORT = Number(argValue("--port", "3210"));
const ROOT = path.resolve(process.cwd(), argValue("--root", "out"));

// Capacitor's WKWebView (and this server, standing in for it) sends
// Cache-Control: no-cache on every request -- see Global Constraints,
// "Local verification harness".
const CACHE_CONTROL = "no-cache";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function existsRelativeToRoot(relativePath: string): boolean {
  return existsSync(path.join(ROOT, relativePath));
}

const server = createServer((req, res) => {
  const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
  const resolved = resolveExportPath(requestUrl.pathname, existsRelativeToRoot);
  const filePath = path.join(ROOT, resolved.replace(/^\/+/, ""));

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": CACHE_CONTROL });
    res.end("Not found");
    return;
  }

  res.writeHead(200, { "Content-Type": contentTypeFor(filePath), "Cache-Control": CACHE_CONTROL });
  res.end(readFileSync(filePath));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Serving ${ROOT} at http://127.0.0.1:${PORT}`);
});
