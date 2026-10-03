import { configuredOrigin, noStoreJson } from "@/lib/http-security";
import { startOnboarding } from "@/lib/pos-payments";
import { posRoute } from "@/lib/pos-route";

/**
 * Creates the Stripe connected account on first use and answers a fresh
 * onboarding link. Its return/refresh URLs are https pages on this server's
 * public origin (APP_ORIGIN; the request's own origin when unset).
 */
export const POST = posRoute({ write: true }, async (req, session) =>
  noStoreJson(await startOnboarding(session.userId, configuredOrigin() ?? req.nextUrl.origin))
);
