/**
 * Passkeys on the client. One module, two ceremonies:
 * - the bundled iOS app (capacitor://localhost) uses the app-target
 *   LashKirjaPasskey plugin (ios/App/App/PasskeyPlugin.swift), because the
 *   WebView origin cannot use the server's RP ID through navigator.credentials;
 * - a normal browser uses @simplewebauthn/browser.
 * Both send the same JSON to the same server routes.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { apiUrl, IS_MOBILE_BUILD } from "@/lib/build-target";
import { acceptIssuedToken } from "@/lib/auth-client";
import { apiFetch } from "@/components/clientFetch";
import { classifyCeremonyError, passkeyFailureMessage, type PasskeyFailure } from "@/lib/passkey-copy";

export { classifyCeremonyError, passkeyFailureMessage, type PasskeyFailure };

interface NativePasskeyPlugin {
  isSupported(): Promise<{ available: boolean }>;
  register(options: { optionsJSON: string }): Promise<Record<string, unknown>>;
  authenticate(options: { optionsJSON: string }): Promise<Record<string, unknown>>;
}

const NativePasskey = registerPlugin<NativePasskeyPlugin>("LashKirjaPasskey");

export interface PasskeyRow {
  id: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type PasskeyOutcome<T = undefined> = { ok: true; value: T } | { ok: false; reason: PasskeyFailure; message?: string };

function isNative(): boolean {
  try {
    return IS_MOBILE_BUILD && Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

let statusPromise: Promise<{ web: boolean; native: boolean }> | null = null;

function serverStatus(): Promise<{ web: boolean; native: boolean }> {
  if (!statusPromise) {
    statusPromise = fetch(apiUrl("/api/auth/passkey/status"), {
      credentials: IS_MOBILE_BUILD ? "omit" : "same-origin",
      cache: "no-store",
    })
      .then(async (response) => (response.ok ? ((await response.json()) as { web: boolean; native: boolean }) : { web: false, native: false }))
      .catch(() => {
        // Offline: try again next time instead of caching "off".
        statusPromise = null;
        return { web: false, native: false };
      });
  }
  return statusPromise;
}

/**
 * Whether this device can use passkeys with this server right now. False
 * hides the passkey UI entirely: server not configured (no WEBAUTHN_RP_ID,
 * or no APPLE_TEAM_ID for the app), iOS older than 16, an IPA built before
 * the plugin, or a browser without WebAuthn.
 */
export async function passkeysAvailable(): Promise<boolean> {
  if (isNative()) {
    if (!Capacitor.isPluginAvailable("LashKirjaPasskey")) return false;
    const [status, support] = await Promise.all([
      serverStatus(),
      NativePasskey.isSupported().catch(() => ({ available: false })),
    ]);
    return status.native && support.available;
  }
  if (typeof window === "undefined" || !browserSupportsWebAuthn()) return false;
  return (await serverStatus()).web;
}

async function runAuthenticationCeremony(
  options: PublicKeyCredentialRequestOptionsJSON,
  autofill: boolean
): Promise<unknown> {
  if (isNative()) {
    return NativePasskey.authenticate({ optionsJSON: JSON.stringify(options) });
  }
  return startAuthentication({ optionsJSON: options, useBrowserAutofill: autofill });
}

async function readError(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Usernameless passkey sign-in. On success the session is in place exactly as
 * after a password sign-in (mobile: bearer token stored; web: cookie set).
 * `autofill` starts a browser conditional-mediation request instead (the
 * passkey appears in the email field's AutoFill list); web only.
 */
export async function signInWithPasskey(options: { autofill?: boolean } = {}): Promise<PasskeyOutcome> {
  const native = isNative();
  const credentials: RequestCredentials = IS_MOBILE_BUILD ? "omit" : "same-origin";
  let start: Response;
  try {
    start = await fetch(apiUrl("/api/auth/passkey/authenticate/options"), {
      method: "POST",
      credentials,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (start.status === 503) return { ok: false, reason: "not-configured" };
  if (start.status === 429) return { ok: false, reason: "rate", message: await readError(start) };
  if (!start.ok) return { ok: false, reason: "failed", message: await readError(start) };
  const { challengeId, options: requestOptions } = (await start.json()) as {
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  };

  let assertion: unknown;
  try {
    assertion = await runAuthenticationCeremony(requestOptions, Boolean(options.autofill) && !native);
  } catch (error) {
    return { ok: false, reason: classifyCeremonyError(error) };
  }

  let finish: Response;
  try {
    finish = await fetch(apiUrl("/api/auth/passkey/authenticate/verify"), {
      method: "POST",
      credentials,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId,
        response: assertion,
        transport: IS_MOBILE_BUILD ? "bearer" : "cookie",
        ...(native ? { device: "ios-app" } : {}),
      }),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (!finish.ok) {
    const message = await readError(finish);
    if (finish.status === 429) return { ok: false, reason: "rate", message };
    if (finish.status === 403) return { ok: false, reason: "closed", message };
    if (finish.status === 503) return { ok: false, reason: "not-configured" };
    return { ok: false, reason: "rejected", message };
  }

  if (IS_MOBILE_BUILD) {
    const body = (await finish.json()) as {
      token?: string;
      expiresAt?: string;
      user?: { userId: string; email: string; firstName: string };
    };
    if (!body.token || !body.user) return { ok: false, reason: "failed" };
    const result = await acceptIssuedToken({ token: body.token, expiresAt: body.expiresAt, user: body.user });
    if (!result.ok) return { ok: false, reason: "failed" };
  }
  return { ok: true, value: undefined };
}

/** Browser only: is AutoFill-assisted passkey sign-in possible here? */
export async function passkeyAutofillSupported(): Promise<boolean> {
  if (isNative() || typeof window === "undefined") return false;
  try {
    return await browserSupportsWebAuthnAutofill();
  } catch {
    return false;
  }
}

/** Stops a pending AutoFill request (before a button-started ceremony, or on unmount). */
export function cancelPasskeyAutofill(): void {
  try {
    WebAuthnAbortService.cancelCeremony();
  } catch {
    // Nothing pending.
  }
}

/**
 * Signed in: creates a passkey on this device and stores it on the server.
 * The current password is required (re-authentication): a session alone
 * cannot add a way to sign in.
 */
export async function createPasskey(currentPassword: string, deviceName?: string): Promise<PasskeyOutcome<PasskeyRow>> {
  const native = isNative();
  let start: Response;
  try {
    start = await apiFetch("/api/auth/passkey/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword }),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (start.status === 503) return { ok: false, reason: "not-configured" };
  // 401 is normally the wrong password (a dead session also answers 401, and
  // its own server message then says so); 400 is a missing password.
  if (start.status === 401 || start.status === 400) {
    return { ok: false, reason: "password", message: await readError(start) };
  }
  if (start.status === 429) return { ok: false, reason: "rate", message: await readError(start) };
  if (!start.ok) return { ok: false, reason: "failed", message: await readError(start) };
  const { challengeId, options } = (await start.json()) as {
    challengeId: string;
    options: PublicKeyCredentialCreationOptionsJSON;
  };

  let attestation: unknown;
  try {
    attestation = native
      ? await NativePasskey.register({ optionsJSON: JSON.stringify(options) })
      : await startRegistration({ optionsJSON: options });
  } catch (error) {
    return { ok: false, reason: classifyCeremonyError(error) };
  }

  let finish: Response;
  try {
    finish = await apiFetch("/api/auth/passkey/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId,
        response: attestation,
        ...(deviceName ? { deviceName } : {}),
        ...(native ? { device: "ios-app" } : {}),
      }),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (!finish.ok) {
    const message = await readError(finish);
    return { ok: false, reason: finish.status === 409 ? "exists" : "failed", message };
  }
  const body = (await finish.json()) as { passkey: PasskeyRow };
  return { ok: true, value: body.passkey };
}

export async function listPasskeys(): Promise<PasskeyRow[]> {
  const response = await apiFetch("/api/auth/passkey");
  if (!response.ok) throw new Error((await readError(response)) ?? "Pääsyavaimia ei saatu ladattua");
  const body = (await response.json()) as { passkeys: PasskeyRow[] };
  return body.passkeys;
}

export async function renamePasskey(id: string, deviceName: string): Promise<void> {
  const response = await apiFetch(`/api/auth/passkey/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceName }),
  });
  if (!response.ok) throw new Error((await readError(response)) ?? "Nimen vaihto epäonnistui");
}

export async function deletePasskey(id: string): Promise<void> {
  const response = await apiFetch(`/api/auth/passkey/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error((await readError(response)) ?? "Poisto epäonnistui");
}
