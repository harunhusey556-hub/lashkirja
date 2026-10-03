import { noStoreJson } from "@/lib/http-security";
import { issueConnectionToken } from "@/lib/pos-payments";
import { posRoute } from "@/lib/pos-route";
import { consumeRateLimit, opaqueRateKey, requestClientKey } from "@/lib/rate-limit";

/**
 * Limits for minting Terminal connection tokens. The SDK asks for one when the
 * Tap to Pay reader connects or reconnects (the reader then stays connected
 * across payments), so a working day is a handful an hour. 10 a minute leaves
 * room for a few quick retries after a failed connect; 60 an hour covers a busy
 * day with a reconnect for every payment. Per client address (only when the
 * proxy is trusted, so the address is real): 30 a minute across owners.
 */
const CONNECTION_TOKEN_LIMITS = {
  perUserMinute: 10,
  perUserHour: 60,
  perAddressMinute: 30,
} as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function limited(userId: string, client: string): number | null {
  const checks = [
    consumeRateLimit(`pos-token:min:${userId}`, CONNECTION_TOKEN_LIMITS.perUserMinute, MINUTE),
    consumeRateLimit(`pos-token:hour:${userId}`, CONNECTION_TOKEN_LIMITS.perUserHour, HOUR),
  ];
  // "direct" means no trusted address: one bucket for everyone, so it is not used.
  if (client !== "direct") {
    checks.push(
      consumeRateLimit(`pos-token:ip:${opaqueRateKey(client)}`, CONNECTION_TOKEN_LIMITS.perAddressMinute, MINUTE)
    );
  }
  const refused = checks.filter((check) => !check.allowed);
  return refused.length > 0 ? Math.max(...refused.map((check) => check.retryAfterSeconds)) : null;
}

/** A Stripe Terminal connection token, minted on the owner's connected account. Never cached. */
export const POST = posRoute({ write: true }, async (req, session) => {
  const retryAfter = limited(session.userId, requestClientKey(req));
  if (retryAfter !== null) {
    return noStoreJson(
      { error: "Liian monta yhteyspyyntöä korttimaksuihin. Yritä hetken kuluttua uudelleen." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }
  return noStoreJson(await issueConnectionToken(session.userId));
});
