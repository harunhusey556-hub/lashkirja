import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { businessProfileSchema, parseBusinessDetails } from "@/lib/onboarding";
import { errorText } from "@/lib/api-errors";
import { guardWrite } from "@/lib/http-security";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      onboarded: true,
      businessDetails: true,
      entityType: true,
      vatRegistered: true,
      vatPeriod: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "Käyttäjää ei löydy" }, { status: 404 });
  }

  const stored = parseBusinessDetails(user.businessDetails);
  const profile = businessProfileSchema.safeParse({
    ...stored,
    entityType: user.entityType,
    vatRegistered: user.vatRegistered,
    vatPeriod: user.vatPeriod,
  });
  return NextResponse.json({
    onboarded: user.onboarded,
    profile: profile.success ? profile.data : stored,
  });
}

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const parsed = businessProfileSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Tarkista yritysmuoto, verokausi ja valinnat." },
      { status: 400 }
    );
  }
  const profile = parsed.data;

  try {
    await prisma.user.update({
      where: { id: session.userId },
      data: {
        onboarded: true,
        entityType: profile.entityType,
        vatRegistered: profile.vatRegistered,
        vatPeriod: profile.vatPeriod,
        businessDetails: JSON.stringify(profile),
      },
    });

    return NextResponse.json({ success: true, profile });
  } catch (error: unknown) {
    console.error("[onboarding]", errorText(error));
    return NextResponse.json(
      { error: "Asetusten tallennus epäonnistui. Yritä myöhemmin uudelleen." },
      { status: 500 }
    );
  }
}
