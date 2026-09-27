import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { requireSession } from "@/lib/session";
import { reinferStatementTransactionTypes } from "@/lib/statements";
import { getStatementForUser } from "@/lib/statement-api";
import { runMatching } from "@/lib/matching";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const { id } = await params;
  const statement = await getStatementForUser(session.userId!, id);
  if (!statement) {
    return NextResponse.json(
      { error: "Tiliotetta ei löytynyt" },
      { status: 404 }
    );
  }

  const updated = await reinferStatementTransactionTypes(id, session.userId!);
  await runMatching(session.userId!).catch((error) =>
    console.error("Matching after type reinfer failed:", error)
  );

  const refreshed = await getStatementForUser(session.userId!, id);
  return NextResponse.json({
    ok: true,
    updated,
    statement: refreshed,
  });
}
