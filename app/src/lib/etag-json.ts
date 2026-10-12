import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * A JSON answer with a strong ETag of its bytes. A client that sends the tag back in If-None-Match
 * gets 304 and no body: the 3 MB bank ledger is not sent again when nothing changed. Cache-Control
 * is `private, no-cache` rather than no-store so a client may keep its copy, but it must ask every
 * time; the data is never served stale. Lives apart from http-security.ts, which stays free of
 * node: imports.
 */
export function revalidatedJson(req: Request, body: unknown): NextResponse {
  const text = JSON.stringify(body);
  const etag = `"${createHash("sha1").update(text).digest("base64url")}"`;
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-cache",
    ETag: etag,
    Vary: "Cookie, Authorization",
    "X-Content-Type-Options": "nosniff",
  };
  const sent = req.headers.get("if-none-match");
  if (sent && sent.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return new NextResponse(text, { status: 200, headers: { ...headers, "Content-Type": "application/json" } });
}
