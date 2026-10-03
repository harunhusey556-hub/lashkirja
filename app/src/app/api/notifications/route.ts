import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { buildNotificationFeed } from "@/lib/notifications";

/**
 * The iPhone app's local notifications (lib/notifications.ts). `since` is the `cursor` of the
 * previous answer; it narrows only what arrived (bank rows, e-mail receipts).
 */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const raw = req.nextUrl.searchParams.get("since");
  let since: Date | null = null;
  if (raw) {
    since = new Date(raw);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || Number.isNaN(since.getTime())) {
      return noStoreJson({ error: "Virheellinen aika (since)." }, { status: 400 });
    }
  }
  return noStoreJson(await buildNotificationFeed(session.userId!, { since }));
});
