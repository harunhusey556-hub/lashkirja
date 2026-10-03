import { noStoreJson } from "@/lib/http-security";
import { getPosStatus } from "@/lib/pos-payments";
import { posRoute } from "@/lib/pos-route";

/** Card payment readiness: server switch, connected account flags, location, owner's switch. */
export const GET = posRoute({ write: false }, async (_req, session) =>
  noStoreJson(await getPosStatus(session.userId))
);
