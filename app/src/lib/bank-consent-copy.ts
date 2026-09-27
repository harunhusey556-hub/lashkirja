/**
 * Copy for a bank consent that can no longer sync. Last success is
 * `lastSuccessAt` only — a failed attempt must not look like a successful fetch.
 */

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
    connection.lastError?.trim() ||
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
