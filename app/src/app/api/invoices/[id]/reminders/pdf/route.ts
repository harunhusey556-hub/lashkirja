import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { renderReminder } from "@/lib/invoice-reminders";

/** The reminder as a file, without sending it: preview before you demand. */
export const GET = withErrorHandler(
  async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await requireSession(req);
    if (!session) throw new UnauthorizedError();

    const { id } = await context.params;
    const { buffer, preview } = await renderReminder(session.userId, id);

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="muistutus-${String(
          preview.invoice.number
        ).padStart(4, "0")}.pdf"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
);
