import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";

const patchSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  entityType: z.enum(["kevytyrittaja", "toiminimi"]).optional(),
  vatRegistered: z.boolean().optional(),
  vatPeriod: z.enum(["month", "quarter", "year"]).optional(),
});

export async function GET() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      firstName: true,
      lastName: true,
      email: true,
      entityType: true,
      vatRegistered: true,
      vatPeriod: true,
      imapAccounts: {
        select: { id: true, email: true }
      }
    },
  });
  if (!user) {
    return NextResponse.json({ error: "Ei käyttäjää" }, { status: 404 });
  }

  return NextResponse.json({ profile: user });
}

export async function PATCH(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  }

  const user = await prisma.user.update({
    where: { id: session.userId },
    data: parsed.data,
    select: {
      firstName: true,
      lastName: true,
      email: true,
      entityType: true,
      vatRegistered: true,
      vatPeriod: true,
    },
  });

  return NextResponse.json({ ok: true, profile: user });
}
