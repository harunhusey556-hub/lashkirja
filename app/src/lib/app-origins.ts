/** Pure: no DB, no next/server. Used by proxy.ts, http-security.ts and
 * session.ts, all of which must stay usable on the DB-free proxy path. */

export const API_VERSION = 1;

/** Local emulation of the native app, served from the mobile export
 * (scripts/mobile/serve-export.ts). Never allowed in production. */
export const DEV_EMULATION_ORIGIN = "http://127.0.0.1:3210";

const DEFAULT_APP_ORIGIN = "capacitor://localhost";

/** The exact-match allowlist of origins the bundled app is ever served from. */
export function appClientOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.MOBILE_APP_ORIGINS?.trim();
  const configured = raw
    ? raw
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    : [DEFAULT_APP_ORIGIN];
  if (env.NODE_ENV === "production") return configured;
  return [...configured, DEV_EMULATION_ORIGIN];
}

/** Exact string match, no wildcards. "null" (the literal Origin browsers
 * send for an opaque/sandboxed request) is never allowed. */
export function isAppClientOrigin(origin: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!origin || origin === "null") return false;
  return appClientOrigins(env).includes(origin);
}

export function corsPreflightHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, Accept",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function corsResponseHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "Retry-After, Content-Disposition, X-LashKirja-Api-Version",
    Vary: "Origin",
  };
}
