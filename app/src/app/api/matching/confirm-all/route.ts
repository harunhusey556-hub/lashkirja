import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { confirmAllSuggestions } from "@/lib/matching";

const bodySchema = z
  .object({
    statementId: z.string().min(1).optional(),
    periodMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  })
  .strict();

/** Accept every pending kuitti suggestion in one action. */
export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  }

  const confirmed = await confirmAllSuggestions(session.userId!, parsed.data);
  return NextResponse.json({ ok: true, confirmed });
}
