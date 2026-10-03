import { noStoreJson } from "@/lib/http-security";
import { refreshOnboarding } from "@/lib/pos-payments";
import { posRoute } from "@/lib/pos-route";

/** Re-reads the connected account from Stripe and creates the Terminal location once. */
export const POST = posRoute({ write: true }, async (_req, session) =>
  noStoreJson(await refreshOnboarding(session.userId))
);
