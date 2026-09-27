import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { createCreditNote } from "@/lib/sales-invoices";

export const POST = withErrorHandler(
  async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await requireSession(req);
    if (!session) throw new UnauthorizedError();
    const crossSite = rejectCrossSite(req);
    if (crossSite) return crossSite;
    const { id } = await context.params;
    const invoice = await createCreditNote(session.userId, id);
    return noStoreJson({ invoice }, { status: 201 });
  }
);
