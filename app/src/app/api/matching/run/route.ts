import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { runMatching } from "@/lib/matching";

export async function POST() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const result = await runMatching(session.userId!);
  return NextResponse.json({ ok: true, ...result });
}
