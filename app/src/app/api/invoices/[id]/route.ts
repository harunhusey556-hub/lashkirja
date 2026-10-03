import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { AppError, UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { buildInvoicePdfData, deleteInvoice, getInvoice, updateInvoice } from "@/lib/sales-invoices";
import { barcodeIssue, buildBankBarcode } from "@/lib/bank-barcode";
import { isoDateSchema, moneySchema } from "@/lib/validation";
import { findPaymentReceiptDuplicates } from "@/lib/alv-period";

const lineSchema = z.object({
  description: z.string().trim().min(1).max(200),
  quantity: z.number().finite(),
  unit: z.string().trim().max(16).optional(),
  unitPrice: moneySchema,
  vatRate: z.number().finite().min(0).max(100),
});

const patchSchema = z
  .object({
    customerId: z.string().uuid().optional(),
    issueDate: isoDateSchema.optional(),
    dueDate: isoDateSchema.optional(),
    notes: z.string().trim().max(2000).nullish(),
    lines: z.array(lineSchema).min(1).max(200).optional(),
    expectedUpdatedAt: z.string().max(40).optional(),
  })
  .refine(
    (value) => Object.keys(value).filter((key) => key !== "expectedUpdatedAt").length > 0,
    "Ei muutettavia kenttiä"
  );

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const { id } = await context.params;
  const invoice = await getInvoice(session.userId, id);
  // Hand-recorded payments that an income receipt seems to count again.
  const paymentDuplicates = await findPaymentReceiptDuplicates(session.userId, { invoiceId: id });
  // The virtuaaliviivakoodi the PDF prints, for the app to copy; or why the invoice has none.
  const pdf = await buildInvoicePdfData(session.userId, id);
  const isCreditNote = pdf.documentKind === "credit_note";
  const barcodeInput = { iban: pdf.seller.iban ?? null, reference: pdf.reference, amountCents: pdf.grossCents };
  const barcode = isCreditNote
    ? null
    : buildBankBarcode({ ...barcodeInput, iban: barcodeInput.iban ?? "", dueDate: `${pdf.dueDate}T00:00:00.000Z` });
  const barcodeProblem = isCreditNote || barcode ? null : barcodeIssue(barcodeInput);
  return noStoreJson({ invoice, paymentDuplicates, barcode, barcodeIssue: barcodeProblem });
});

export const PATCH = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const { id } = await context.params;
  const input = patchSchema.parse(await req.json());
  // An edit must name the version it was made on; without it a stale screen
  // would silently overwrite a newer change (428 Precondition Required).
  if (!input.expectedUpdatedAt) {
    throw new AppError(
      "Muokkaus vaatii laskun version. Lataa lasku uudelleen ja yritä sitten.",
      "PRECONDITION_REQUIRED",
      428
    );
  }
  const invoice = await updateInvoice(session.userId, id, input);
  return noStoreJson({ invoice });
});

export const DELETE = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

  const { id } = await context.params;
  await deleteInvoice(session.userId, id);
  return noStoreJson({ ok: true });
});
