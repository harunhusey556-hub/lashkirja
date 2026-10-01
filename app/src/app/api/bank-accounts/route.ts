import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { createBankAccount, getBankOverview } from "@/lib/bank-accounts";
import { getBankPosition } from "@/lib/bank-position";
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
  // OWN-18: the accounts of a bank consent are the owner's accounts too. The
  // list stays the ledger accounts (they open a detail sheet); the total and
  // the count say what is really connected, each IBAN once.
  const { position } = await getBankPosition(session.userId, { overview });
  return noStoreJson({
    ...overview,
    connected: {
      accountCount: position.connectedOnly.length,
      accounts: position.connectedOnly,
    },
    combined: {
      state: position.state,
      accountCount: position.accountCount,
      totalBalance: position.totalBalance,
      excludedCurrencies: position.excludedCurrencies,
      reconnectBank: position.reconnectBank,
    },
  });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const body = createSchema.parse(await req.json());
  const { restored, ...account } = await createBankAccount(session.userId, body);
  // An archived account that held the IBAN came back instead of a second one.
  return noStoreJson(restored ? { account, restored: true } : { account }, { status: restored ? 200 : 201 });
});
