import { sealData, unsealData } from "iron-session";
import { sessionOptions, type SessionData } from "@/lib/session-options";
import { SESSION_ABSOLUTE_MS } from "@/lib/session-limits";

/** No DB import here on purpose: proxy.ts reads a credential on every /api/*
 * request and must stay DB-free on that path. */

/** A bearer token lives 30 days, same as the web cookie. */
export const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Clients should proactively refresh once a token is older than this; the
 * server does not enforce it — an unexpired token still works right up to
 * TOKEN_TTL_SECONDS. */
export const TOKEN_REFRESH_AFTER_SECONDS = 7 * 24 * 60 * 60;

export type Credential =
  | { kind: "bearer"; data: SessionData & { userId: string; sessionId: string } }
  | { kind: "cookie"; data: SessionData & { userId: string } };

/** The token string exactly as sent: the device signature of a refresh covers it. */
export function bearerTokenFrom(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match ? match[1] : null;
}

/**
 * Reads whichever credential the request actually presents.
 *
 * Authorization header wins. A malformed or failing bearer never falls back
 * to the cookie — an `Authorization: Basic ...` header, a garbled token, or
 * an expired one all resolve to `null`, not to whatever the cookie says.
 *
 * The cookie is ignored entirely when the request Origin is an app client
 * origin: those requests carry no ambient credentials (no CapacitorHttp, no
 * cross-origin `credentials: "include"`), so a Cookie header reaching the
 * server from that origin is never the caller's own session.
 */
export async function readCredential(
  headers: Headers,
  cookieValue: string | undefined,
  isAppOrigin: (origin: string | null) => boolean
): Promise<Credential | null> {
  const authorizationHeader = headers.get("authorization");
  const bearerToken = bearerTokenFrom(authorizationHeader);
  if (bearerToken) {
    try {
      const data = await unsealData<SessionData>(bearerToken, {
        password: sessionOptions.password as string,
        ttl: TOKEN_TTL_SECONDS,
      });
      if (data.kind !== "bearer" || !data.userId || !data.sessionId) return null;
      // Tokens from before rotation carry neither field; the row decides for them.
      if (data.gen !== undefined && !(Number.isInteger(data.gen) && data.gen >= 0)) return null;
      if (data.sessionStartedAt !== undefined) {
        if (!Number.isFinite(data.sessionStartedAt)) return null;
        if (Date.now() - data.sessionStartedAt > SESSION_ABSOLUTE_MS) return null;
      }
      return { kind: "bearer", data: data as SessionData & { userId: string; sessionId: string } };
    } catch {
      return null;
    }
  }
  // Authorization header present but not a recognizable bearer token: never
  // fall back to the cookie.
  if (authorizationHeader) return null;

  if (isAppOrigin(headers.get("origin"))) return null;
  if (!cookieValue) return null;
  try {
    const data = await unsealData<SessionData>(cookieValue, {
      password: sessionOptions.password as string,
      ttl: sessionOptions.ttl,
    });
    // A bearer-sealed payload replayed as a cookie value must never be
    // accepted as a cookie credential.
    if (data.kind === "bearer") return null;
    if (!data.userId) return null;
    return { kind: "cookie", data: data as SessionData & { userId: string } };
  } catch {
    return null;
  }
}

export async function sealBearerToken(data: {
  userId: string;
  email: string;
  firstName: string;
  sessionId: string;
  /** Token generation inside the session row; absent = 0 (legacy tokens). */
  gen?: number;
  /** Epoch ms of the row's createdAt: lets the DB-free check enforce the absolute cap. */
  sessionStartedAt?: number;
}): Promise<{ token: string; expiresAt: Date }> {
  const payload: SessionData = { ...data, kind: "bearer" };
  const token = await sealData(payload, {
    password: sessionOptions.password as string,
    ttl: TOKEN_TTL_SECONDS,
  });
  return { token, expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000) };
}
