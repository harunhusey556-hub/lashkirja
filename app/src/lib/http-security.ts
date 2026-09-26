import { NextRequest, NextResponse } from "next/server";

const JSON_BODY_LIMIT = 256 * 1024;

/** The origin the deployment was told to expect, or null when unset. */
export function configuredOrigin(): string | null {
  const configured = process.env.APP_ORIGIN?.trim();
  if (!configured) return null;
  try {
    return new URL(configured).origin;
  } catch {
    if (process.env.NODE_ENV === "production") {
      throw new Error("APP_ORIGIN must be an absolute URL");
    }
    return null;
  }
}

/**
 * CSRF guard.
 *
 * When APP_ORIGIN is configured the full origin must match. When it is not,
 * the Origin header is compared against the request's own Host - a header a
 * browser will not let page scripts forge - rather than against
 * `req.nextUrl.origin`, which does not carry the real host under `next start`
 * and rejected every same-origin form POST, login included.
 *
 * Behind a proxy that rewrites Host, set APP_ORIGIN.
 */
export function rejectCrossSite(req: NextRequest): NextResponse | null {
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Pyyntö estettiin" }, { status: 403 });
  }

  const origin = req.headers.get("origin");
  if (!origin) return null;

  const configured = configuredOrigin();
  if (configured) {
    return origin === configured
      ? null
      : NextResponse.json({ error: "Pyyntö estettiin" }, { status: 403 });
  }

  const host = req.headers.get("host");
  if (!host) return null;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return NextResponse.json({ error: "Pyyntö estettiin" }, { status: 403 });
  }
  return originHost === host
    ? null
    : NextResponse.json({ error: "Pyyntö estettiin" }, { status: 403 });
}

export function rejectOversizedContentLength(
  req: NextRequest,
  maximum = JSON_BODY_LIMIT
): NextResponse | null {
  const raw = req.headers.get("content-length");
  if (!raw) return null;
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size < 0) {
    return NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  }
  if (size > maximum) {
    return NextResponse.json({ error: "Pyyntö on liian suuri" }, { status: 413 });
  }
  return null;
}

/**
 * Validates a user-supplied "continue to this page after login" target.
 *
 * Only a same-app, single-leading-slash path is accepted — this is the one
 * guard standing between a `?next=` query param and an open-redirect
 * vulnerability, so it must reject anything that a browser could interpret
 * as pointing off-origin (protocol-relative `//`, backslash tricks, an
 * embedded scheme, or literal whitespace/control characters).
 */
export function safeInternalPath(
  path: string | null | undefined,
  fallback = "/dashboard"
): string {
  if (!path || path.length > 2048) return fallback;
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    return fallback;
  }
  // eslint-disable-next-line no-control-regex -- deliberately screening out control chars
  if (/[\x00-\x1f\x7f]/.test(path)) return fallback;
  return path;
}

export function noStoreJson(
  body: unknown,
  init?: { status?: number; headers?: HeadersInit }
): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}
