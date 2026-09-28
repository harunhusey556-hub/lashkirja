import { NextRequest, NextResponse } from "next/server";
import { requireSession, sessionOptions } from "@/lib/session";
import { isAppClientOrigin } from "@/lib/app-origins";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    const response = NextResponse.json({ user: null }, { status: 401 });
    // A bearer caller, or an app-origin caller, never sent this cookie in
    // the first place (readCredential ignores cookies from an app origin
    // entirely) - clearing it here is a needless Set-Cookie on every failed
    // call, and the plan's Task 13 check expects none for a garbage bearer
    // (final review M7). Only a real web/cookie caller gets it cleared, so
    // the browser stops resending a stale or revoked cookie forever.
    const hasBearer = Boolean(req.headers.get("authorization"));
    const isAppOrigin = isAppClientOrigin(req.headers.get("origin"));
    if (!hasBearer && !isAppOrigin) {
      response.cookies.set(sessionOptions.cookieName, "", {
        ...sessionOptions.cookieOptions,
        maxAge: 0,
      });
    }
    return response;
  }
  return NextResponse.json({
    user: {
      userId: session.userId,
      email: session.email,
      firstName: session.firstName,
    },
  });
}
