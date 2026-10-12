import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { revalidatedJson } from "@/lib/etag-json";
import { readDataVersion } from "@/lib/data-version";
import { receiptKindWhere } from "@/lib/receipt-filters";
import { countInvoicesByDisplayStatus } from "@/lib/sales-invoices";
import { countPurchaseInvoicesByDisplayStatus } from "@/lib/purchase-invoices";

/**
 * Everything the app shell needs before its first screen, in one round trip (W24): who is signed
 * in, the freshness counter (same number as GET /api/sync/version) and the badge counts. Before
 * this the shell asked /api/auth/me, then each tab its own counts, one after another.
 * Each part is the same code its own endpoint runs, so the numbers cannot differ from it.
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ user: null }, { status: 401 });

  const [dataVersion, pendingReceipts, invoices, purchaseInvoices] = await Promise.all([
    readDataVersion(session.userId),
    // Same rows as Koti's review queue: a bill filed as an ostolasku is not a kuitti to review.
    prisma.receipt.count({ where: { userId: session.userId, reviewStatus: "pending", ...receiptKindWhere("receipt") } }),
    countInvoicesByDisplayStatus(session.userId, {}),
    countPurchaseInvoicesByDisplayStatus(session.userId),
  ]);

  return revalidatedJson(req, {
    user: { userId: session.userId, email: session.email, firstName: session.firstName },
    dataVersion,
    counts: {
      receipts: { pending: pendingReceipts },
      invoices,
      purchaseInvoices,
    },
  });
}
