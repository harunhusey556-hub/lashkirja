import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { guardWrite } from "@/lib/http-security";
import { consumeRateLimit } from "@/lib/rate-limit";
import { AccountSecurityError, recordAccountRequest } from "@/lib/account-security";
import { listUserAccountRequests } from "@/lib/account-requests";
import { CLOSE_REQUEST_MESSAGE } from "@/lib/account-copy";

const bodySchema = z.object({
  kind: z.enum(["close", "export"]),
  currentPassword: z.string().min(1).max(1024),
});

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  const requests = await listUserAccountRequests(session.userId);
  return NextResponse.json({ requests });
}

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  const limit = consumeRateLimit(`account-request:${session.userId}`, 5, 60 * 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Liian monta yritystä. Yritä myöhemmin uudelleen." },
      { status: 429 }
    );
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  }
  try {
    const request = await recordAccountRequest(
      session.userId,
      parsed.data.kind,
      parsed.data.currentPassword
    );
    const message =
      parsed.data.kind === "close"
        ? CLOSE_REQUEST_MESSAGE
        : "Pyyntö kopiosta on kirjattu. Tuki ilmoittaa sinulle sähköpostilla, kun kopio on valmis. Kuukausipaketti löytyy Raporteista jo nyt.";
    return NextResponse.json({ ok: true, request, message });
  } catch (error) {
    if (error instanceof AccountSecurityError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
