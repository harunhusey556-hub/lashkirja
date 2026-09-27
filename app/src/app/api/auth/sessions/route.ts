import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { z } from "zod";
import { requireSession, sessionOptions, type SessionData } from "@/lib/session";
import { guardWrite } from "@/lib/http-security";
import { listAuthSessions, revokeAuthSessions } from "@/lib/account-security";
import { prisma } from "@/lib/db";

const bodySchema = z.object({
  scope: z.enum(["others", "all"]).optional(),
  id: z.string().uuid().optional(),
});

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  const sessions = await listAuthSessions(session.userId, session.sessionId);
  return NextResponse.json({ sessions });
}

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || (!parsed.data.scope && !parsed.data.id)) {
    return NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  }

  let signedOut = false;
  if (parsed.data.id) {
    const target = await prisma.authSession.findFirst({
      where: { id: parsed.data.id, userId: session.userId, revokedAt: null },
      select: { id: true },
    });
    if (!target) return NextResponse.json({ error: "Istuntoa ei löydy" }, { status: 404 });
    await prisma.authSession.update({
      where: { id: target.id },
      data: { revokedAt: new Date() },
    });
    signedOut = target.id === session.sessionId;
  } else if (parsed.data.scope === "all") {
    await revokeAuthSessions(session.userId);
    signedOut = true;
  } else {
    await revokeAuthSessions(session.userId, session.sessionId);
  }

  const res = NextResponse.json({ ok: true, signedOut });
  if (signedOut) {
    const iron = await getIronSession<SessionData>(req, res, sessionOptions);
    iron.destroy();
  }
  return res;
}
