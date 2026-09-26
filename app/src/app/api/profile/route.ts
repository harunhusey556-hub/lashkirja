import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { isValidIban, normalizeIban } from "@/lib/iban";
import { isValidBusinessId, normalizeBusinessId } from "@/lib/finnish-reference";
import { updateReminderSettings } from "@/lib/invoice-reminders";

const patchSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  entityType: z.enum(["kevytyrittaja", "toiminimi"]).optional(),
  vatRegistered: z.boolean().optional(),
  vatPeriod: z.enum(["month", "quarter", "year"]).optional(),
  // Seller details printed on sales invoices.
  businessName: z.string().trim().max(120).nullish(),
  businessId: z.string().trim().max(20).nullish(),
  addressStreet: z.string().trim().max(120).nullish(),
  addressPostalCode: z.string().trim().max(20).nullish(),
  addressCity: z.string().trim().max(80).nullish(),
  phone: z.string().trim().max(40).nullish(),
  invoiceIban: z.string().trim().max(42).nullish(),
  invoiceBic: z.string().trim().max(11).nullish(),
  invoiceTerms: z.string().trim().max(1000).nullish(),
  // Collection settings; validated by updateReminderSettings so the rules live
  // in one place rather than being restated here.
  lateInterestPercent: z.number().finite().nullable().optional(),
  reminderFee: z.number().finite().optional(),
});

const SELLER_SELECT = {
  lateInterestPercent: true,
  reminderFeeCents: true,
  businessName: true,
  businessId: true,
  addressStreet: true,
  addressPostalCode: true,
  addressCity: true,
  phone: true,
  invoiceIban: true,
  invoiceBic: true,
  invoiceTerms: true,
} as const;

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
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
      ...SELLER_SELECT,
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
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  }

  const { lateInterestPercent, reminderFee, ...data } = parsed.data;

  if (lateInterestPercent !== undefined || reminderFee !== undefined) {
    await updateReminderSettings(session.userId, { lateInterestPercent, reminderFee });
  }

  // An IBAN or Y-tunnus that fails its check digit must never reach an invoice.
  if (data.invoiceIban) {
    const iban = normalizeIban(data.invoiceIban);
    if (!isValidIban(iban)) {
      return NextResponse.json({ error: "IBAN ei ole kelvollinen" }, { status: 400 });
    }
    data.invoiceIban = iban;
  }
  if (data.businessId) {
    if (!isValidBusinessId(data.businessId)) {
      return NextResponse.json({ error: "Y-tunnus ei ole kelvollinen" }, { status: 400 });
    }
    data.businessId = normalizeBusinessId(data.businessId);
  }

  const user = await prisma.user.update({
    where: { id: session.userId },
    data,
    select: {
      firstName: true,
      lastName: true,
      email: true,
      entityType: true,
      vatRegistered: true,
      vatPeriod: true,
      ...SELLER_SELECT,
    },
  });

  return NextResponse.json({ ok: true, profile: user });
}
