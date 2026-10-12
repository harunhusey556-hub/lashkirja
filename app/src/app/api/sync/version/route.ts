import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { readSyncVersion } from "@/lib/data-version";

export const dynamic = "force-dynamic";

/**
 * `{ dataVersion, bank: { lastChangeAt, accounts[] }, receipts: { lastChangeAt }, invoices: { lastChangeAt } }`.
 * Cheap enough to poll on every app foreground and tab switch: a client refetches a screen only when
 * `dataVersion` differs from the one it rendered (lib/data-version.ts).
 */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  return noStoreJson(await readSyncVersion(session.userId));
});
