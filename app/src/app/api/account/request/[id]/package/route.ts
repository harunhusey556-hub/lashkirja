import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { AccountRequestError, readAccountPackageForUser } from "@/lib/account-requests";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  const { id } = await context.params;
  try {
    const bytes = await readAccountPackageForUser(session.userId, id);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="tietokopio.zip"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AccountRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
