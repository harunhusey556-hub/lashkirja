import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { createBankAccount, getBankOverview } from "@/lib/bank-accounts";
import { isoDateSchema, moneySchema } from "@/lib/validation";

const createSchema = z.object({
  name: z.string().trim().min(1, "Tilin nimi puuttuu").max(80),
  bankName: z.string().trim().max(80).nullish(),
  iban: z.string().trim().max(42).nullish(),
  bic: z.string().trim().max(11).nullish(),
  currency: z.string().trim().length(3).default("EUR"),
  openingBalance: moneySchema.default(0),
  openingDate: isoDateSchema,
  isDefault: z.boolean().optional(),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const includeArchived = req.nextUrl.searchParams.get("includeArchived") === "1";
  const overview = await getBankOverview(session.userId, { includeArchived });
  return noStoreJson(overview);
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const body = createSchema.parse(await req.json());
  const account = await createBankAccount(session.userId, body);
  return noStoreJson({ account }, { status: 201 });
});
