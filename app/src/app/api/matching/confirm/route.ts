import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import {
  confirmMatch,
  MatchConflictError,
  MatchNotFoundError,
} from "@/lib/matching";
import { withErrorHandler, AppError, NotFoundError } from "@/lib/api-errors";

const confirmSchema = z.object({
  transactionId: z.string().min(1),
  receiptId: z.string().min(1),
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession();
  if (!session) {
    throw new AppError("Ei kirjautunut", "UNAUTHORIZED", 401);
  }

  const parsed = confirmSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  }
  const { transactionId, receiptId } = parsed.data;

  try {
    const tx = await prisma.transaction.findFirst({
      where: { id: transactionId, statement: { userId: session.userId! } },
      select: { suggestedReceiptId: true },
    });
    const fromSuggestion = tx?.suggestedReceiptId === receiptId;
    await confirmMatch(
      session.userId!,
      transactionId,
      receiptId,
      fromSuggestion
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof MatchNotFoundError) {
      throw new NotFoundError("Ei löytynyt");
    }
    if (error instanceof MatchConflictError) {
      throw new AppError(error.message, "CONFLICT", 409);
    }
    throw error;
  }
});
