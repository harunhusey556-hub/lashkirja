import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, ValidationError, withErrorHandler } from "@/lib/api-errors";
import { findBankRowsForPayment, getInvoice } from "@/lib/sales-invoices";
import { eurosToCents } from "@/lib/money";
import { isoDateSchema, moneySchema } from "@/lib/validation";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Incoming bank rows that a payment being recorded by hand most likely is,
 * so the payment sheet can offer to attach the row instead of leaving it to
 * be counted a second time as an income receipt.
 */
export const GET = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const { id } = await context.params;
  // Ownership: a foreign invoice id is a 404, not a bank-row lookup.
  await getInvoice(session.userId, id);

  const params = req.nextUrl.searchParams;
  const amount = moneySchema.safeParse(Number(params.get("amount")));
  const paidDate = isoDateSchema.safeParse(params.get("paidDate"));
  if (!amount.success || !paidDate.success) {
    throw new ValidationError("Summa tai päivä puuttuu.");
  }
  return noStoreJson({
    candidates: await findBankRowsForPayment(session.userId, eurosToCents(amount.data), paidDate.data),
  });
});
