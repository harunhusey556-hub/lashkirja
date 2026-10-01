/**
 * Copy for a bank consent that can no longer sync. Last success is
 * `lastSuccessAt` only — a failed attempt must not look like a successful fetch.
 */

/** The bank itself withdrew the consent (the owner did not press Katkaise). */
export const CONSENT_REVOKED_MESSAGE = "Pankki on peruuttanut luvan.";
/** The bank session ended without a withdrawal; the owner connects again. */
export const EXPIRED_CONNECTION_MESSAGE = "Yhteys vanhentui. Yhdistä uudelleen.";
/** The same sentence as older rows stored it, with a dash. */
const OLD_EXPIRED_CONNECTION_MESSAGE = "Yhteys vanhentui — yhdistä uudelleen.";
/** A bank asked the app to slow down. */
export const RATE_LIMITED_MESSAGE = "Pankki pyytää odottamaan. Yritä hetken päästä uudelleen.";
/** Any bank-side failure the owner cannot act on. */
export const GENERIC_BANK_ERROR = "Pankkiyhteys epäonnistui. Yritä uudelleen.";

/** Older rows stored text written for the server's operator; never show it. */
const OPERATOR_TEXT = /ENABLEBANKING|APP_ID|Control Panel|sovelluksen avain|palvelimelta|Forbidden|Unauthorized/i;

/** A stored bank error, as the owner may read it. */
export function calmBankError(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  if (trimmed === OLD_EXPIRED_CONNECTION_MESSAGE) return EXPIRED_CONNECTION_MESSAGE;
  return OPERATOR_TEXT.test(trimmed) ? GENERIC_BANK_ERROR : trimmed;
}

/** True for a connection the bank itself ended with a withdrawn consent. */
export function consentWithdrawn(connection: { lastError: string | null }): boolean {
  return connection.lastError?.trim() === CONSENT_REVOKED_MESSAGE;
}

export interface ConsentAccount {
  iban: string;
  label: string | null;
  inScope: boolean;
}

export interface ConsentConnection {
  status: string;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastSyncAt: string | null;
  validUntil: string | null;
  accounts: ConsentAccount[];
}

export interface ConsentReconnectCopy {
  reason: string;
  accounts: string[];
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
}

function consentExpired(connection: ConsentConnection, now: Date): boolean {
  if (!connection.validUntil) return false;
  const until = new Date(connection.validUntil).getTime();
  return Number.isFinite(until) && until <= now.getTime();
}

export function consentReconnectCopy(
  connection: ConsentConnection,
  now: Date = new Date()
): ConsentReconnectCopy | null {
  const expired = consentExpired(connection, now);
  const broken =
    connection.status === "expired" ||
    connection.status === "revoked" ||
    connection.status === "error" ||
    expired;
  if (!broken) return null;

  const reason =
    calmBankError(connection.lastError) ||
    (connection.status === "revoked"
      ? "Suostumus on katkaistu pankissa."
      : connection.status === "error" && !expired
        ? "Yhteys epäonnistui."
        : "Suostumus on vanhentunut.");

  const scoped = connection.accounts.filter((account) => account.inScope);
  const listed = scoped.length > 0 ? scoped : connection.accounts;
  const accounts = listed.map((account) => {
    const label = account.label?.trim();
    return label ? `${label} · ${account.iban}` : account.iban;
  });

  return {
    reason,
    accounts,
    lastSuccessAt: connection.lastSuccessAt,
    lastAttemptAt: connection.lastSyncAt,
  };
}
