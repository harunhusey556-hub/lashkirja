import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { guardWrite } from "@/lib/http-security";
import { deletePasskey, deviceNameSchema, renamePasskey } from "@/lib/passkey";
import { noStore, passkeyErrorResponse } from "@/lib/passkey-session";

type RouteContext = { params: Promise<{ id: string }> };

const patchSchema = z.object({ deviceName: deviceNameSchema });

export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const blocked = guardWrite(req, 4 * 1024);
    if (blocked) return blocked;
    const session = await requireSession(req);
    if (!session) return noStore(NextResponse.json({ error: "Kirjautuminen vaaditaan" }, { status: 401 }));
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Virheellinen nimi";
      return noStore(NextResponse.json({ error: message }, { status: 400 }));
    }
    const { id } = await context.params;
    await renamePasskey(session.userId, id, parsed.data.deviceName);
    return noStore(NextResponse.json({ ok: true, deviceName: parsed.data.deviceName }));
  } catch (error) {
    return passkeyErrorResponse(error, "Passkey rename failed");
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const blocked = guardWrite(req, 4 * 1024);
    if (blocked) return blocked;
    const session = await requireSession(req);
    if (!session) return noStore(NextResponse.json({ error: "Kirjautuminen vaaditaan" }, { status: 401 }));
    const { id } = await context.params;
    await deletePasskey(session.userId, id);
    return noStore(NextResponse.json({ ok: true }));
  } catch (error) {
    return passkeyErrorResponse(error, "Passkey delete failed");
  }
}
