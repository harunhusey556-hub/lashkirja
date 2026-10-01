import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey, isoBase64URL } from "@simplewebauthn/server/helpers";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { passkeyConfig, type PasskeyConfig } from "@/lib/passkey-config";
import { CLOSED_LOGIN_MESSAGE } from "@/lib/account-copy";

/** A challenge is good for five minutes and exactly one verify call. */
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** What the authenticator UI is told it may take. Shorter than the TTL. */
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;
/** ES256 (every Apple passkey), EdDSA, RS256 (Windows Hello). No PQC: this
 * list must match what the stored-key check below accepts. */
export const PASSKEY_ALGORITHMS = [-7, -8, -257] as const;
const MAX_PASSKEYS_PER_USER = 20;

/** Same text for every failed passkey sign-in: never says whether the
 * credential, the account or the signature was the problem. */
export const PASSKEY_SIGNIN_FAILED = "Pääsyavain ei kelpaa. Kirjaudu salasanalla.";
export const PASSKEY_NOT_CONFIGURED = "Pääsyavaimet eivät ole käytössä tällä palvelimella.";

export class PasskeyError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PasskeyError";
    this.status = status;
  }
}

function requireConfig(): PasskeyConfig {
  const config = passkeyConfig();
  if (!config) throw new PasskeyError(PASSKEY_NOT_CONFIGURED, 503);
  return config;
}

// ---------------------------------------------------------------------------
// Request shapes. The JSON the browser library and the native plugin return.
// Bounded so a hostile body cannot make the verifier chew megabytes.
// ---------------------------------------------------------------------------

const b64url = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/);

export const registrationResponseSchema = z.object({
  id: b64url(1400),
  rawId: b64url(1400),
  type: z.literal("public-key"),
  response: z
    .object({
      clientDataJSON: b64url(8192),
      attestationObject: b64url(32768),
      transports: z.array(z.string().max(32)).max(8).optional(),
    })
    .passthrough(),
  authenticatorAttachment: z.string().max(32).optional().nullable(),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional().default({}),
});

export const authenticationResponseSchema = z.object({
  id: b64url(1400),
  rawId: b64url(1400),
  type: z.literal("public-key"),
  response: z
    .object({
      clientDataJSON: b64url(8192),
      authenticatorData: b64url(8192),
      signature: b64url(4096),
      userHandle: b64url(1024).optional().nullable(),
    })
    .passthrough(),
  authenticatorAttachment: z.string().max(32).optional().nullable(),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional().default({}),
});

export const deviceNameSchema = z.string().trim().min(1, "Anna nimi").max(60, "Enintään 60 merkkiä");

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

async function storeChallenge(purpose: "register" | "authenticate", challenge: string, userId: string | null) {
  const now = new Date();
  // Keep the table small: expired rows are never useful.
  await prisma.passkeyChallenge.deleteMany({ where: { expiresAt: { lt: now } } });
  const row = await prisma.passkeyChallenge.create({
    data: {
      purpose,
      challenge,
      userId,
      expiresAt: new Date(now.getTime() + PASSKEY_CHALLENGE_TTL_MS),
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Reads and deletes in one step. The row is gone before the response is
 * checked, so a second verify with the same challenge (a replay, or a
 * double tap racing the first) finds nothing. Two concurrent callers can
 * both read the row; only the one whose delete removes it proceeds.
 */
async function takeChallenge(id: string, purpose: "register" | "authenticate") {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
  const row = await prisma.passkeyChallenge.findUnique({ where: { id } });
  if (!row) return null;
  const removed = await prisma.passkeyChallenge.deleteMany({ where: { id } });
  if (removed.count !== 1) return null;
  if (row.purpose !== purpose) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return row;
}

/** The WebAuthn user handle: the user id's UTF-8 bytes. Opaque to the
 * authenticator, and lets sign-in cross-check which account a passkey says
 * it belongs to. */
function userHandleFor(userId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(userId));
}

function parseTransports(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * App-owned check that a stored key is one sign-in can actually use. Not left
 * to the library's registration path alone: a dependency upgrade that starts
 * accepting a new algorithm must not let us store a key verify then refuses.
 */
function assertUsablePublicKey(publicKey: Uint8Array): void {
  let alg: unknown;
  try {
    const decoded = decodeCredentialPublicKey(new Uint8Array(publicKey));
    alg = decoded.get(cose.COSEKEYS.alg);
  } catch {
    throw new PasskeyError("Pääsyavainta ei voitu tallentaa. Yritä uudelleen.", 400);
  }
  if (typeof alg !== "number" || !(PASSKEY_ALGORITHMS as readonly number[]).includes(alg)) {
    throw new PasskeyError("Tätä pääsyavainta ei tueta. Kokeile toista laitetta.", 400);
  }
}

// ---------------------------------------------------------------------------
// Registration (signed in)
// ---------------------------------------------------------------------------

export async function createRegistrationOptions(user: {
  id: string;
  email: string;
  firstName: string;
}): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const config = requireConfig();
  const existing = await prisma.passkeyCredential.findMany({
    where: { userId: user.id },
    select: { id: true, transports: true },
  });
  if (existing.length >= MAX_PASSKEYS_PER_USER) {
    throw new PasskeyError(`Enintään ${MAX_PASSKEYS_PER_USER} pääsyavainta. Poista ensin vanha.`, 409);
  }
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: user.email,
    userDisplayName: user.firstName || user.email,
    userID: userHandleFor(user.id),
    timeout: CEREMONY_TIMEOUT_MS,
    attestationType: "none",
    // Authenticated caller: listing the caller's own credentials is fine and
    // stops the same authenticator registering twice.
    excludeCredentials: existing.map((row) => ({ id: row.id, transports: parseTransports(row.transports) })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: [...PASSKEY_ALGORITHMS],
  });
  const challengeId = await storeChallenge("register", options.challenge, user.id);
  return { challengeId, options };
}

export async function verifyRegistration(input: {
  userId: string;
  challengeId: string;
  response: unknown;
  deviceName: string;
}): Promise<{ id: string; deviceName: string; createdAt: Date }> {
  const config = requireConfig();
  const parsed = registrationResponseSchema.safeParse(input.response);
  const challenge = await takeChallenge(input.challengeId, "register");
  if (!challenge || challenge.userId !== input.userId) {
    throw new PasskeyError("Pyyntö vanheni. Yritä uudelleen.", 400);
  }
  if (!parsed.success) throw new PasskeyError("Pääsyavainta ei voitu tallentaa. Yritä uudelleen.", 400);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: parsed.data as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...PASSKEY_ALGORITHMS],
    });
  } catch {
    throw new PasskeyError("Pääsyavainta ei voitu tallentaa. Yritä uudelleen.", 400);
  }
  if (!verification.verified) {
    throw new PasskeyError("Pääsyavainta ei voitu tallentaa. Yritä uudelleen.", 400);
  }

  const { credential } = verification.registrationInfo;
  assertUsablePublicKey(credential.publicKey);

  const taken = await prisma.passkeyCredential.findUnique({ where: { id: credential.id }, select: { id: true } });
  if (taken) throw new PasskeyError("Tämä pääsyavain on jo tallennettu.", 409);

  const transports = credential.transports ?? parsed.data.response.transports;
  return prisma.passkeyCredential.create({
    data: {
      id: credential.id,
      userId: input.userId,
      publicKey: new Uint8Array(credential.publicKey),
      counter: BigInt(credential.counter),
      transports: transports && transports.length > 0 ? JSON.stringify(transports) : null,
      deviceName: input.deviceName,
    },
    select: { id: true, deviceName: true, createdAt: true },
  });
}

// ---------------------------------------------------------------------------
// Authentication (signed out, usernameless)
// ---------------------------------------------------------------------------

export async function createAuthenticationOptions(): Promise<{
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  const config = requireConfig();
  // No allowCredentials: a discoverable-credential request. Listing ids here
  // would tell an anonymous caller which credentials exist.
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    timeout: CEREMONY_TIMEOUT_MS,
    userVerification: "required",
  });
  delete (options as { allowCredentials?: unknown }).allowCredentials;
  const challengeId = await storeChallenge("authenticate", options.challenge, null);
  return { challengeId, options };
}

export type PasskeySignIn =
  | { ok: true; user: { id: string; email: string; firstName: string } }
  | { ok: false; status: 400 | 401 | 403 | 503; error: string };

export async function verifyAuthentication(input: {
  challengeId: string;
  response: unknown;
}): Promise<PasskeySignIn> {
  const config = passkeyConfig();
  if (!config) return { ok: false, status: 503, error: PASSKEY_NOT_CONFIGURED };
  const failed = { ok: false as const, status: 401 as const, error: PASSKEY_SIGNIN_FAILED };

  // Consumed first, whatever happens next: one challenge, one attempt.
  const challenge = await takeChallenge(input.challengeId, "authenticate");
  const parsed = authenticationResponseSchema.safeParse(input.response);
  if (!challenge || !parsed.success || parsed.data.id !== parsed.data.rawId) return failed;

  const stored = await prisma.passkeyCredential.findUnique({
    where: { id: parsed.data.id },
    include: { user: { select: { id: true, email: true, firstName: true, accessDisabledAt: true } } },
  });
  if (!stored) return failed;

  const userHandle = parsed.data.response.userHandle;
  if (userHandle && userHandle !== isoBase64URL.fromBuffer(userHandleFor(stored.userId))) return failed;

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: parsed.data as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(stored.publicKey),
        counter: Number(stored.counter),
        transports: parseTransports(stored.transports),
      },
      requireUserVerification: true,
    });
  } catch {
    // Includes a counter that did not move forward (a cloned authenticator).
    return failed;
  }
  if (!verification.verified) return failed;

  if (stored.user.accessDisabledAt) {
    return { ok: false, status: 403, error: CLOSED_LOGIN_MESSAGE };
  }

  await prisma.passkeyCredential.update({
    where: { id: stored.id },
    data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() },
  });
  return {
    ok: true,
    user: { id: stored.user.id, email: stored.user.email, firstName: stored.user.firstName },
  };
}

// ---------------------------------------------------------------------------
// Management (signed in)
// ---------------------------------------------------------------------------

export async function listPasskeys(userId: string) {
  return prisma.passkeyCredential.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, deviceName: true, createdAt: true, lastUsedAt: true },
  });
}

export async function renamePasskey(userId: string, id: string, deviceName: string) {
  const result = await prisma.passkeyCredential.updateMany({ where: { id, userId }, data: { deviceName } });
  if (result.count !== 1) throw new PasskeyError("Pääsyavainta ei löydy.", 404);
}

export async function deletePasskey(userId: string, id: string) {
  const result = await prisma.passkeyCredential.deleteMany({ where: { id, userId } });
  if (result.count !== 1) throw new PasskeyError("Pääsyavainta ei löydy.", 404);
}
