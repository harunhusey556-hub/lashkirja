import { NextRequest, NextResponse } from "next/server";
import { requireSession, sessionOptions } from "@/lib/session";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    // A stale or revoked cookie is what usually lands here — clear it so
    // the client's next request (and a subsequent /login visit) sees a
    // clean, signed-out state instead of resending it forever.
    const response = NextResponse.json({ user: null }, { status: 401 });
    response.cookies.set(sessionOptions.cookieName, "", {
      ...sessionOptions.cookieOptions,
      maxAge: 0,
    });
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
