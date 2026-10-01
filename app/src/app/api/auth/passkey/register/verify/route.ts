import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { guardWrite } from "@/lib/http-security";
import { deviceLabel } from "@/lib/session-policy";
import { deviceNameSchema, verifyRegistration } from "@/lib/passkey";
import { noStore, passkeyErrorResponse } from "@/lib/passkey-session";

const bodySchema = z.object({
  challengeId: z.string().min(1).max(64),
  response: z.unknown(),
  deviceName: z.string().max(200).optional(),
  device: z.literal("ios-app").optional(),
});

export async function POST(req: NextRequest) {
  try {
    const blocked = guardWrite(req, 64 * 1024);
    if (blocked) return blocked;
    const session = await requireSession(req);
    if (!session) return noStore(NextResponse.json({ error: "Kirjautuminen vaaditaan" }, { status: 401 }));

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return noStore(NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 }));
    }
    const named = deviceNameSchema.safeParse(parsed.data.deviceName ?? "");
    const deviceName = named.success
      ? named.data
      : deviceLabel(req.headers.get("user-agent"), parsed.data.device).slice(0, 60);

    const passkey = await verifyRegistration({
      userId: session.userId,
      challengeId: parsed.data.challengeId,
      response: parsed.data.response,
      deviceName,
    });
    return noStore(NextResponse.json({ passkey: { ...passkey, lastUsedAt: null } }, { status: 201 }));
  } catch (error) {
    return passkeyErrorResponse(error, "Passkey registration failed");
  }
}
