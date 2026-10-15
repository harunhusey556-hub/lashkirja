import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { guardWrite, noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { matchPurchasePaymentsFromBank } from "@/lib/purchase-invoices";
import { setReceiptKind } from "@/lib/receipt-kind";

type RouteContext = { params: Promise<{ id: string }> };

const bodySchema = z.object({ kind: z.enum(["receipt", "invoice"]) }).strict();

/**
 * "Kuitti ⇄ Ostolasku" on the upload screen: the owner corrects what the AI
 * decided a just-saved document is (lib/receipt-kind.ts). The receipt screen's
 * own switch stays PATCH /api/receipts/[id] with `documentType`.
 */
export const POST = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError("Ei kirjautunut");
  const { id } = await context.params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw parsed.error;

  const result = await setReceiptKind(session.userId!, id, parsed.data.kind);
  // A bill just filed may already have its payment in the bank (W27), as after the receipt screen's switch.
  if (result.purchaseInvoiceAction === "filed" || result.purchaseInvoiceAction === "reopened") {
    await matchPurchasePaymentsFromBank(session.userId!).catch((error) =>
      console.error("Purchase payment matching after a kind change failed:", error)
    );
  }
  return noStoreJson({ ok: true, ...result });
});
