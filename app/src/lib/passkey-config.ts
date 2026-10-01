/**
 * Passkey (WebAuthn) relying-party configuration. Pure: reads env only, no DB.
 *
 * WEBAUTHN_RP_ID      the public server host, e.g. "lashkirja.example.ts.net".
 *                     Unset or invalid = passkeys are off and the UI hides them.
 * WEBAUTHN_ORIGINS    comma-separated origins a ceremony may come from.
 *                     Default: https://<WEBAUTHN_RP_ID>. A native iOS passkey
 *                     always signs https://<rpId>, so keep that one listed.
 * WEBAUTHN_RP_NAME    shown by the authenticator. Default "LashKirja".
 * APPLE_TEAM_ID       10-character Apple team id. Needed for the
 *                     apple-app-site-association file; without it the iOS app
 *                     cannot use passkeys (the web still can).
 */

export const PASSKEY_BUNDLE_ID = "fi.tiyouba.lashkirja";

export interface PasskeyConfig {
  rpId: string;
  rpName: string;
  origins: string[];
  appleTeamId: string | null;
}

const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

function normalizeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function appleTeamId(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.APPLE_TEAM_ID?.trim().toUpperCase();
  return raw && TEAM_ID_PATTERN.test(raw) ? raw : null;
}

/** Null when passkeys are not configured (or misconfigured) on this server. */
export function passkeyConfig(env: NodeJS.ProcessEnv = process.env): PasskeyConfig | null {
  const rpId = env.WEBAUTHN_RP_ID?.trim().toLowerCase();
  if (!rpId || !HOST_PATTERN.test(rpId)) return null;

  const listed = (env.WEBAUTHN_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeOrigin)
    .filter((value): value is string => value !== null);
  const origins = listed.length > 0 ? Array.from(new Set(listed)) : [`https://${rpId}`];

  return {
    rpId,
    rpName: env.WEBAUTHN_RP_NAME?.trim() || "LashKirja",
    origins,
    appleTeamId: appleTeamId(env),
  };
}

/** What the unauthenticated status endpoint may say. No account data. */
export function passkeyStatus(env: NodeJS.ProcessEnv = process.env): {
  web: boolean;
  native: boolean;
} {
  const config = passkeyConfig(env);
  return {
    web: config !== null,
    // The iOS app also needs the associated-domains file, which needs the team id.
    native: config !== null && config.appleTeamId !== null,
  };
}

/** Body of /.well-known/apple-app-site-association, or null when not configured. */
export function appleAppSiteAssociation(env: NodeJS.ProcessEnv = process.env): {
  webcredentials: { apps: string[] };
} | null {
  const teamId = appleTeamId(env);
  if (!teamId) return null;
  return { webcredentials: { apps: [`${teamId}.${PASSKEY_BUNDLE_ID}`] } };
}
