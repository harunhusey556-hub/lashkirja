import { NextResponse, type NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { sessionOptions, type SessionData } from "@/lib/session";
import { openAuthSession } from "@/lib/account-security";
import { sealBearerToken } from "@/lib/auth-credential";
import { PasskeyError } from "@/lib/passkey";

type SignedInUser = { id: string; email: string; firstName: string };

/**
 * After a passkey sign-in, exactly what a password sign-in returns:
 * - "bearer": the /api/auth/token body (bundled app; no cookie is set),
 * - "cookie": the /api/auth/login JSON body plus the iron-session cookie.
 * Both open a fresh AuthSession row, so the device shows up under Laitteet
 * and logout/revocation work the same.
 */
export async function issuePasskeySession(
  req: NextRequest,
  user: SignedInUser,
  transport: "bearer" | "cookie",
  device?: "ios-app"
): Promise<NextResponse> {
  if (transport === "bearer") {
    const row = await openAuthSession(user.id, req.headers.get("user-agent"), device);
    const sealed = await sealBearerToken({
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      sessionId: row.id,
    });
    return noStore(
      NextResponse.json({
        token: sealed.token,
        tokenType: "Bearer",
        expiresAt: sealed.expiresAt.toISOString(),
        user: { userId: user.id, email: user.email, firstName: user.firstName },
      })
    );
  }

  const row = await openAuthSession(user.id, req.headers.get("user-agent"));
  const res = noStore(NextResponse.json({ ok: true, user: { firstName: user.firstName, email: user.email } }));
  const session = await getIronSession<SessionData>(req, res, sessionOptions);
  session.userId = user.id;
  session.email = user.email;
  session.firstName = user.firstName;
  session.sessionId = row.id;
  await session.save();
  return res;
}

export function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

export function passkeyErrorResponse(error: unknown, logLabel: string): NextResponse {
  if (error instanceof PasskeyError) {
    return noStore(NextResponse.json({ error: error.message }, { status: error.status }));
  }
  console.error(`${logLabel}:`, error);
  return noStore(NextResponse.json({ error: "Pääsyavaintoiminto epäonnistui. Yritä uudelleen." }, { status: 500 }));
}
