import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { confirmAllSuggestions, confirmProposedMatches } from "@/lib/matching";

const pairSchema = z.object({ transactionId: z.string().min(1), receiptId: z.string().min(1) });
const bodySchema = z
  .object({
    statementId: z.string().min(1).optional(),
    periodMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    /** The exact pairs a match review proposed; confirming these links only them. */
    pairs: z.array(pairSchema).min(1).max(500).optional(),
  })
  .strict();

/** Accept every pending kuitti suggestion in one action (or exactly the given pairs). */
export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  }

  if (parsed.data.pairs) {
    const result = await confirmProposedMatches(session.userId!, parsed.data.pairs);
    return NextResponse.json({ ok: true, ...result });
  }
  const confirmed = await confirmAllSuggestions(session.userId!, parsed.data);
  return NextResponse.json({ ok: true, confirmed });
}
