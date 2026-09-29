import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { assistantAvailable } from "@/lib/ai-assistant";

/**
 * Whether the assistant can answer free-form questions (a language model is
 * configured on the server). The drawer asks this once per session so it can
 * say calmly what works instead of failing each question (SHELL-11, OWN-09).
 * It deliberately returns nothing else: no provider name, no setting name.
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }
  return NextResponse.json(
    { available: assistantAvailable() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
