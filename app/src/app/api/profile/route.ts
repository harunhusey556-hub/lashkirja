import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { isValidIban, normalizeIban } from "@/lib/iban";
import { isValidBusinessId, normalizeBusinessId } from "@/lib/finnish-reference";
import { reminderSettingsData } from "@/lib/invoice-reminders";
import { ValidationError } from "@/lib/api-errors";
import { ENTITY_TYPES } from "@/lib/onboarding";
import { guardWrite } from "@/lib/http-security";
import { SELLER_LIMITS } from "@/lib/seller-limits";
import { zodIssuesFi } from "@/lib/zod-messages";

const patchSchema = z.object({
  // Trimmed and capped like the other text fields. The messages are the ones
  // the person sees, so they are plain Finnish.
  firstName: z
    .string()
    .trim()
    .min(1, "Anna etunimi.")
    .max(120, "Etunimi saa olla enintään 120 merkkiä.")
    .optional(),
  lastName: z
    .string()
    .trim()
    .min(1, "Anna sukunimi.")
    .max(120, "Sukunimi saa olla enintään 120 merkkiä.")
    .optional(),
  entityType: z.enum(ENTITY_TYPES).optional(),
  vatRegistered: z.boolean().optional(),
  vatPeriod: z.enum(["month", "quarter", "year"]).optional(),
  // Seller details printed on sales invoices.
  businessName: z.string().trim().max(SELLER_LIMITS.businessName).nullish(),
  businessId: z.string().trim().max(SELLER_LIMITS.businessId).nullish(),
  addressStreet: z.string().trim().max(SELLER_LIMITS.addressStreet).nullish(),
  addressPostalCode: z.string().trim().max(SELLER_LIMITS.addressPostalCode).nullish(),
  addressCity: z.string().trim().max(SELLER_LIMITS.addressCity).nullish(),
  phone: z.string().trim().max(SELLER_LIMITS.phone).nullish(),
  invoiceIban: z.string().trim().max(SELLER_LIMITS.invoiceIban).nullish(),
  invoiceBic: z.string().trim().max(SELLER_LIMITS.invoiceBic).nullish(),
  invoiceTerms: z.string().trim().max(SELLER_LIMITS.invoiceTerms).nullish(),
  // Collection settings; validated by reminderSettingsData so the rules live
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
      pendingEmail: true,
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
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // The first problem is named in Finnish with its field and limit; `field`
    // and `details` let the form mark the field (F14, F64).
    const issues = zodIssuesFi(parsed.error);
    return NextResponse.json(
      { error: issues[0]?.message ?? "Tarkista lomakkeen tiedot", field: issues[0]?.field ?? null, details: issues },
      { status: 400 }
    );
  }

  const { lateInterestPercent, reminderFee, ...data } = parsed.data;

  // Validate every field before any write. A failed IBAN must not leave a
  // reminder-fee change behind.
  let reminderData: ReturnType<typeof reminderSettingsData>;
  try {
    reminderData = reminderSettingsData({ lateInterestPercent, reminderFee });
  } catch (error) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
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
    data: { ...data, ...reminderData },
    select: {
      firstName: true,
      lastName: true,
      email: true,
      pendingEmail: true,
      entityType: true,
      vatRegistered: true,
      vatPeriod: true,
      ...SELLER_SELECT,
      // The same shape as GET: a client that keeps the answer keeps its mailboxes.
      imapAccounts: { select: { id: true, email: true } },
    },
  });

  return NextResponse.json({ ok: true, profile: user });
}
