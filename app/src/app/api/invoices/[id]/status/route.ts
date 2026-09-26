import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { setInvoiceStatus } from "@/lib/sales-invoices";

const bodySchema = z.object({ status: z.enum(["draft", "sent", "paid", "credited"]) });

export const POST = withErrorHandler(
  async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await requireSession(req);
    if (!session) throw new UnauthorizedError();

    const crossSite = rejectCrossSite(req);
    if (crossSite) return crossSite;
    const oversized = rejectOversizedContentLength(req);
    if (oversized) return oversized;

    const { id } = await context.params;
    const { status } = bodySchema.parse(await req.json());
    return noStoreJson({ invoice: await setInvoiceStatus(session.userId, id, status) });
  }
);
