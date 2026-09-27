import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { listWorkQueue } from "@/lib/work-queue";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  const items = await listWorkQueue(session.userId!);
  return noStoreJson({ items });
}
