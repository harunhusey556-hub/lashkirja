import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { openBankRowsWhere } from "@/lib/bank-open-rows";

/** `{ open }`: bank rows that still need the owner, counted without loading the ledger. */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const open = await prisma.transaction.count({ where: openBankRowsWhere(session.userId!) });
  return noStoreJson({ open });
});
