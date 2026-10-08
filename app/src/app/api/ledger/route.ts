import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { ledgerYear, ledgerYearSchema } from "@/lib/ledger/period";

/**
 * GET /api/ledger?year=2026 — the double-entry books of one fiscal year, derived
 * from the documents (lib/ledger): päiväkirja, pääkirja, saldoluettelo,
 * tuloslaskelma and tase. Amounts are cents.
 */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const raw = req.nextUrl.searchParams.get("year");
  const year = raw ? ledgerYearSchema.parse(raw) : new Date().getUTCFullYear();
  return noStoreJson(await ledgerYear(session.userId!, year));
});
