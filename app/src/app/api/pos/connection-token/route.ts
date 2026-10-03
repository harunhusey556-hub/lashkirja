import { noStoreJson } from "@/lib/http-security";
import { issueConnectionToken } from "@/lib/pos-payments";
import { posRoute } from "@/lib/pos-route";

/** A Stripe Terminal connection token, minted on the owner's connected account. Never cached. */
export const POST = posRoute({ write: true }, async (_req, session) =>
  noStoreJson(await issueConnectionToken(session.userId))
);
