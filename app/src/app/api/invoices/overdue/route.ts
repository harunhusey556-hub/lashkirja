import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { listOverdueInvoices } from "@/lib/invoice-reminders";

/** The reminder work list: overdue and unpaid, worst first. */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  return noStoreJson({ invoices: await listOverdueInvoices(session.userId) });
});
