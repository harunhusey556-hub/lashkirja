/**
 * Shared authentication for scheduled routes.
 *
 * These endpoints act for every user at once, so an unauthenticated one is a
 * lever for anybody who finds the URL. With CRON_SECRET set it must match;
 * without it the route runs only outside production, where a developer is
 * triggering it by hand.
 */
import { NextRequest, NextResponse } from "next/server";

export type CronAuthResult = { ok: true } | { ok: false; response: NextResponse };

export function checkCronAuth(req: NextRequest): CronAuthResult {
  const configured = process.env.CRON_SECRET?.trim();

  if (configured) {
    const header = req.headers.get("authorization");
    const provided = header?.startsWith("Bearer ")
      ? header.slice(7)
      : req.nextUrl.searchParams.get("secret");

    if (provided !== configured) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      };
    }
    return { ok: true };
  }

  if (process.env.NODE_ENV === "production") {
    console.warn("Scheduled route called without CRON_SECRET configured; refusing.");
    return {
      ok: false,
      response: NextResponse.json(
        { error: "CRON_SECRET puuttuu palvelimen asetuksista." },
        { status: 500 }
      ),
    };
  }

  return { ok: true };
}
