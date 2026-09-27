import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ user: null }, { status: 401 });
  }
  return NextResponse.json({
    user: {
      userId: session.userId,
      email: session.email,
      firstName: session.firstName,
    },
  });
}
