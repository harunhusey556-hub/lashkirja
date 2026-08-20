import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { parseBusinessDetails, BusinessProfile } from "@/lib/onboarding";

export async function GET() {
  const session = await requireSession();
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

  const profile = parseBusinessDetails(user.businessDetails);
  return NextResponse.json({
    onboarded: user.onboarded,
    profile: {
      ...profile,
      entityType: (user.entityType as any) || profile.entityType,
      vatRegistered: user.vatRegistered ?? profile.vatRegistered,
      vatPeriod: (user.vatPeriod as any) || profile.vatPeriod,
    },
  });
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as Partial<BusinessProfile>;

    const entityType = body.entityType || "toiminimi";
    const vatRegistered = Boolean(body.vatRegistered);
    const vatPeriod = body.vatPeriod || "month";

    const profile: BusinessProfile = {
      entityType,
      vatRegistered,
      vatPeriod,
      salesTypes: body.salesTypes || ["ripsipalvelut"],
      expenseCategories: body.expenseCategories || ["tarvikkeet"],
      summaryNote: body.summaryNote,
    };

    await prisma.user.update({
      where: { id: session.userId },
      data: {
        onboarded: true,
        entityType,
        vatRegistered,
        vatPeriod,
        businessDetails: JSON.stringify(profile),
      },
    });

    return NextResponse.json({ success: true, profile });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Virhe tallennettaessa asetuksia" },
      { status: 500 }
    );
  }
}
