import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { prisma } from "@/lib/db";
import { redirectResponse, sessionOptions, type SessionData } from "@/lib/session";
import { guardWrite } from "@/lib/http-security";
import { readCredential } from "@/lib/auth-credential";

// A bearer caller has no cookie to begin with (CapacitorHttp stays
// disabled, and fetch never sends cookies cross-origin without
// credentials: "include"), so the app-origin cookie exemption does not
// matter here — logout already prefers the Authorization header and never
// falls back to a stray cookie for that caller.
const denyAppOrigin = () => false;

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req, 16 * 1024);
  if (blocked) return blocked;
  const wantsJson =
    (req.headers.get("accept") || "").includes("application/json") ||
    (req.headers.get("content-type") || "").includes("application/json");
  const res = wantsJson ? NextResponse.json({ ok: true }) : redirectResponse("/login");
  try {
    const cookieValue = req.cookies.get(sessionOptions.cookieName)?.value;
    const credential = await readCredential(req.headers, cookieValue, denyAppOrigin);
    if (credential?.data.sessionId) {
      await prisma.authSession.updateMany({
        where: { id: credential.data.sessionId, userId: credential.data.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    if (credential?.kind !== "bearer") {
      const session = await getIronSession<SessionData>(req, res, sessionOptions);
      session.destroy();
    }
    return res;
  } catch (error) {
    console.error("Logout failed", error);
    return NextResponse.json(
      { error: "Uloskirjautuminen epäonnistui. Yritä uudelleen." },
      { status: 500 }
    );
  }
}
