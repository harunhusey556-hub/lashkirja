import { NextRequest, NextResponse } from "next/server";

const JSON_BODY_LIMIT = 256 * 1024;

export function configuredOrigin(req: NextRequest): string {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      if (process.env.NODE_ENV === "production") {
        throw new Error("APP_ORIGIN must be an absolute URL");
      }
    }
  }
  return req.nextUrl.origin;
}

export function rejectCrossSite(req: NextRequest): NextResponse | null {
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Pyyntö estettiin" }, { status: 403 });
  }

  const origin = req.headers.get("origin");
  const configured = configuredOrigin(req);
  if (
    origin &&
    origin !== configured &&
    (process.env.NODE_ENV === "production" || process.env.APP_ORIGIN)
  ) {
    return NextResponse.json({ error: "Pyyntö estettiin" }, { status: 403 });
  }
  return null;
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

export function noStoreJson(
  body: unknown,
  init?: { status?: number; headers?: HeadersInit }
): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}
