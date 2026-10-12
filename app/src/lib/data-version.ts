import { prisma } from "@/lib/db";

/**
 * The freshness contract (GET /api/sync/version, and the bank sync and statement import responses).
 * `dataVersion` is a per-user counter that SQLite triggers bump on every write to the bank, receipt
 * and invoice tables (migration 20261015090000_data_version), so a client that remembers the number
 * it last rendered knows from one cheap request whether anything it shows is stale. The *_At fields
 * say which area moved.
 */
export interface BankAccountFreshness {
  /** The ledger account (BankAccount.id); null for a connected account not added to the books. */
  bankAccountId: string | null;
  /** The bank consent's account (ConnectedAccount.id); null for a file-only account. */
  connectedAccountId: string | null;
  name: string | null;
  iban: string | null;
  currency: string;
  /** When the bank connection last fetched; null for a file-only account. */
  lastSyncAt: string | null;
  /** The balance the bank reported at the last fetch, in cents; null when the bank never gave one. */
  balanceCents: number | null;
  balanceAt: string | null;
}

export interface SyncVersion {
  dataVersion: number;
  bank: { lastChangeAt: string | null; accounts: BankAccountFreshness[] };
  receipts: { lastChangeAt: string | null };
  invoices: { lastChangeAt: string | null };
}

type VersionRow = { version: number | bigint; bankAt: string | null; receiptsAt: string | null; invoicesAt: string | null };
type ConnectedRow = {
  id: string;
  iban: string;
  label: string | null;
  currency: string;
  balanceCents: number | bigint | null;
  balanceAt: string | Date | null;
  lastSyncAt: string | Date | null;
};

// The table is read raw: it is written only by triggers, and a raw read does not depend on the
// generated client knowing the model.
function iso(value: string | Date | null): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The user's change counter alone: one primary-key read. */
export async function readDataVersion(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<VersionRow[]>`SELECT "version", "bankAt", "receiptsAt", "invoicesAt" FROM "DataVersion" WHERE "userId" = ${userId}`;
  return rows[0] ? Number(rows[0].version) : 0;
}

/** The whole freshness picture: three small reads, no row loading. */
export async function readSyncVersion(userId: string): Promise<SyncVersion> {
  const [versionRows, connected, accounts] = await Promise.all([
    prisma.$queryRaw<VersionRow[]>`SELECT "version", "bankAt", "receiptsAt", "invoicesAt" FROM "DataVersion" WHERE "userId" = ${userId}`,
    prisma.$queryRaw<ConnectedRow[]>`
      SELECT a."id", a."iban", a."label", a."currency", a."balanceCents", a."balanceAt", c."lastSyncAt"
      FROM "ConnectedAccount" a JOIN "BankConnection" c ON c."id" = a."connectionId"
      WHERE a."userId" = ${userId} AND a."inScope" = 1 AND c."status" = 'active'
      ORDER BY a."iban", a."id"`,
    prisma.bankAccount.findMany({
      where: { userId, archivedAt: null },
      select: { id: true, name: true, iban: true, currency: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
  ]);
  const row = versionRows[0];
  const byIban = new Map<string, ConnectedRow>();
  for (const account of connected) if (!byIban.has(account.iban)) byIban.set(account.iban, account);
  const fromConnected = (account: ConnectedRow | undefined) => ({
    connectedAccountId: account?.id ?? null,
    lastSyncAt: iso(account?.lastSyncAt ?? null),
    balanceCents: account?.balanceCents == null ? null : Number(account.balanceCents),
    balanceAt: iso(account?.balanceAt ?? null),
  });
  const ledger: BankAccountFreshness[] = accounts.map((account) => {
    const match = account.iban ? byIban.get(account.iban) : undefined;
    if (account.iban) byIban.delete(account.iban);
    return { bankAccountId: account.id, name: account.name, iban: account.iban, currency: account.currency, ...fromConnected(match) };
  });
  // A connected account the owner has not added to the books still has a balance to show.
  const connectedOnly: BankAccountFreshness[] = [...byIban.values()].map((account) => ({
    bankAccountId: null,
    name: account.label,
    iban: account.iban,
    currency: account.currency,
    ...fromConnected(account),
  }));
  return {
    dataVersion: row ? Number(row.version) : 0,
    bank: { lastChangeAt: iso(row?.bankAt ?? null), accounts: [...ledger, ...connectedOnly] },
    receipts: { lastChangeAt: iso(row?.receiptsAt ?? null) },
    invoices: { lastChangeAt: iso(row?.invoicesAt ?? null) },
  };
}
