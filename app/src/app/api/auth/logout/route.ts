import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { prisma } from "@/lib/db";
import { redirectResponse, sessionOptions, type SessionData } from "@/lib/session";
import { guardWrite } from "@/lib/http-security";

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req, 16 * 1024);
  if (blocked) return blocked;
  const wantsJson =
    (req.headers.get("accept") || "").includes("application/json") ||
    (req.headers.get("content-type") || "").includes("application/json");
  const res = wantsJson ? NextResponse.json({ ok: true }) : redirectResponse("/login");
  try {
    const session = await getIronSession<SessionData>(req, res, sessionOptions);
    if (session.userId && session.sessionId) {
      await prisma.authSession.updateMany({
        where: { id: session.sessionId, userId: session.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    session.destroy();
    return res;
  } catch (error) {
    console.error("Logout failed", error);
    return NextResponse.json(
      { error: "Uloskirjautuminen epäonnistui. Yritä uudelleen." },
      { status: 500 }
    );
  }
}
