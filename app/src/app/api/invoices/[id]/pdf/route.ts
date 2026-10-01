import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { buildInvoicePdfData, invoicePdfFileName } from "@/lib/sales-invoices";
import { renderInvoicePdf } from "@/lib/invoice-pdf";

export const GET = withErrorHandler(
  async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await requireSession(req);
    if (!session) throw new UnauthorizedError();

    const { id } = await context.params;
    const data = await buildInvoicePdfData(session.userId, id);
    const pdf = await renderInvoicePdf(data);

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${invoicePdfFileName(data.number, data.documentKind)}"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
);
