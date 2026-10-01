import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { listPasskeys } from "@/lib/passkey";
import { noStore, passkeyErrorResponse } from "@/lib/passkey-session";

/** The signed-in user's passkeys. /api/auth/* is public in proxy.ts, so the
 * session check here is the gate. */
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    if (!session) return noStore(NextResponse.json({ error: "Kirjautuminen vaaditaan" }, { status: 401 }));
    const passkeys = await listPasskeys(session.userId);
    return noStore(NextResponse.json({ passkeys }));
  } catch (error) {
    return passkeyErrorResponse(error, "Passkey list failed");
  }
}
