import { prisma } from "../db";
import { decrypt } from "../encryption";
import { autoGenerateIncomeReceipts } from "../income-automation";
import { runMatching } from "../matching";
import { centsToEuros } from "../money";
import { inferTransactionType } from "../statements";
import {
  EnableBankingClient,
  EnableBankingError,
  collectAccountTransactions,
  isTerminalSessionError,
  publicBankError,
  sessionTerminalStatus,
} from "./client";
import { isBankSyncDue, overlapDateFrom } from "./consent";
import { attendedHeaders } from "./connect";
import {
  contentFingerprint,
  formatIbanDisplay,
  isFingerprintRef,
  mapBookedTransaction,
  pickBookedBalance,
  withOccurrenceRefs,
  type MappedBankTransaction,
} from "./mapping";
import type { PsuContext } from "./client";
import { withTrackedJob } from "../job-tracker";
import { getLockedThrough, isDateLocked, isMonthLocked } from "../period-lock";
import { normalizeIban } from "../iban";
import { fallbackStatementMonth, statementMonthOrFallback } from "../report-calendar";
import type { AccountSyncRow } from "../bank-sync-summary";

const DEAD_SESSION_STATUS = new Set(["EXPIRED", "CLOSED", "REVOKED", "CANCELLED", "INVALID"]);

export type BankSyncAccountRow = AccountSyncRow & {
  /** The bank had more pages than one pull reads; the account is not caught up. */
  partial?: boolean;
  /** Rows left out because their month is closed (period lock). */
  heldBack?: number;
};

export interface BankSyncResult {
  connectionId: string;
  status: string;
  imported: number;
  skipped: number;
  statementId: string | null;
  statementIds: string[];
  accounts: BankSyncAccountRow[];
  /** Rows left out because their month is closed; they come when it is reopened. */
  heldBack: number;
  /** True when something was left out, so lastSuccessAt did not move. */
  partial: boolean;
  /** The plain-language reason, the same text the connection card shows. */
  notice: string | null;
}

export function heldBackNotice(count: number): string {
  return count === 1
    ? "Kuukausi on lukittu, 1 tapahtuma jäi tuomatta."
    : `Kuukausi on lukittu, ${count} tapahtumaa jäi tuomatta.`;
}

export const PARTIAL_PULL_NOTICE =
  "Kaikkia tapahtumia ei saatu haettua kerralla. Haku jatkuu seuraavalla kerralla.";

export async function syncBankConnection(
  userId: string,
  connectionId: string,
  options: { attended: boolean; context?: PsuContext | null; client?: EnableBankingClient } = {
    attended: false,
  }
): Promise<BankSyncResult> {
  return withTrackedJob(
    userId,
    {
      kind: "bank_sync",
      title: "Pankkitapahtumien haku",
      resourceType: "bank_connection",
      resourceId: connectionId,
    },
    () => syncBankConnectionUntracked(userId, connectionId, options)
  );
}

async function syncBankConnectionUntracked(
  userId: string,
  connectionId: string,
  options: { attended: boolean; context?: PsuContext | null; client?: EnableBankingClient } = {
    attended: false,
  }
): Promise<BankSyncResult> {
  const connection = await prisma.bankConnection.findFirst({
    where: { id: connectionId, userId },
    include: { accounts: true },
  });
  if (!connection || connection.status === "revoked") {
    throw new EnableBankingError("Pankkiyhteyttä ei löytynyt.", 404, "NOT_FOUND");
  }
  if (connection.status === "expired") {
    throw new EnableBankingError("Yhteys vanhentui — yhdistä uudelleen.", 409, "EXPIRED_SESSION");
  }
  if (connection.status !== "active" || !connection.sessionIdEnc) {
    throw new EnableBankingError("Pankkiyhteys ei ole valmis. Yhdistä pankki uudelleen.", 409, "WRONG_SESSION_STATUS");
  }
  if (connection.validUntil && connection.validUntil.getTime() <= Date.now()) {
    await markConnection(connection.id, "expired", "Yhteys vanhentui — yhdistä uudelleen.");
    throw new EnableBankingError("Yhteys vanhentui — yhdistä uudelleen.", 409, "EXPIRED_SESSION");
  }

  const inScope = connection.accounts.filter((account) => account.inScope);
  if (inScope.length === 0) {
    throw new EnableBankingError("Valitse ainakin yksi tili ennen hakua.", 400, "NO_ACCOUNTS_ADDED");
  }

  const psuHeaders = options.attended
    ? attendedHeaders(connection.requiredPsuHeaders, options.context ?? null)
    : undefined;
  const client = options.client ?? new EnableBankingClient();
  let sessionId: string;
  try {
    sessionId = decrypt(connection.sessionIdEnc);
  } catch {
    await markConnection(connection.id, "error", "Pankkiyhteyden istuntoa ei voitu lukea. Yhdistä uudelleen.");
    throw new EnableBankingError(
      "Pankkiyhteyden istuntoa ei voitu lukea. Yhdistä uudelleen.",
      409,
      "SESSION_DOES_NOT_EXIST"
    );
  }

  try {
    const remote = await client.getSession(sessionId);
    if (remote.status && DEAD_SESSION_STATUS.has(remote.status)) {
      const status = remote.status === "REVOKED" ? "revoked" : "expired";
      await markConnection(connection.id, status, "Yhteys vanhentui — yhdistä uudelleen.");
      throw new EnableBankingError("Yhteys vanhentui — yhdistä uudelleen.", 409, "EXPIRED_SESSION");
    }
  } catch (error) {
    const terminal = sessionTerminalStatus(error);
    if (terminal) {
      await markConnection(connection.id, terminal, "Yhteys vanhentui — yhdistä uudelleen.");
      throw new EnableBankingError(
        "Yhteys vanhentui — yhdistä uudelleen.",
        409,
        terminal === "revoked" ? "REVOKED_SESSION" : "EXPIRED_SESSION"
      );
    }
    if (error instanceof EnableBankingError && (error.status === 401 || error.status === 403)) {
      throw error;
    }
    console.error("Enable Banking session check failed", {
      connectionId: connection.id,
      code: error instanceof EnableBankingError ? error.code : "unknown",
    });
  }

  await prisma.bankConnection.update({
    where: { id: connection.id },
    data: { lastSyncAt: new Date() },
  });

  const firstSync = connection.lastSuccessAt == null;
  const dateFrom = connection.lastSuccessAt ? overlapDateFrom(connection.lastSuccessAt) : undefined;
  let imported = 0;
  let skipped = 0;
  const statementIds = new Set<string>();
  const failures: string[] = [];
  const accounts: BankSyncAccountRow[] = [];
  let succeeded = 0;
  let truncatedAccounts = 0;
  let heldBack = 0;

  const accountName = (account: { label: string | null; iban: string }) => {
    const label = account.label?.trim();
    const iban = formatIbanDisplay(account.iban);
    return label ? `${label} ${iban}` : iban;
  };

  for (const account of inScope) {
    try {
      const { transactions, truncated } = await collectAccountTransactions(client, {
        accountUid: account.providerAccountUid,
        firstSync,
        dateFrom,
        historyFrom: connection.historyFrom ?? undefined,
        psuHeaders,
      });
      const mapped = withOccurrenceRefs(
        transactions
          .map((tx) => mapBookedTransaction(tx, account.iban))
          .filter((tx): tx is MappedBankTransaction => tx !== null)
      );
      const written = await writeTransactions({
        userId,
        aspspName: connection.aspspName,
        rows: mapped,
      });
      imported += written.imported;
      skipped += written.skipped;
      heldBack += written.heldBack;
      for (const id of written.statementIds) statementIds.add(id);

      try {
        const balances = await client.getAccountBalances(account.providerAccountUid, psuHeaders);
        const picked = pickBookedBalance(balances);
        if (picked) {
          await prisma.connectedAccount.update({
            where: { id: account.id },
            data: { balanceCents: picked.amountCents, balanceAt: new Date() },
          });
        }
      } catch (error) {
        if (isTerminalSessionError(error)) throw error;
        console.error("Enable Banking balance fetch failed", {
          connectionId: connection.id,
          code: error instanceof EnableBankingError ? error.code : "unknown",
        });
      }
      succeeded += 1;
      if (truncated) truncatedAccounts += 1;
      accounts.push({
        accountId: account.id,
        name: accountName(account),
        ok: true,
        imported: written.imported,
        skipped: written.skipped,
        error: null,
        ...(truncated ? { partial: true } : {}),
        ...(written.heldBack > 0 ? { heldBack: written.heldBack } : {}),
      });
    } catch (error) {
      const terminal = sessionTerminalStatus(error);
      if (terminal) {
        const message = "Yhteys vanhentui — yhdistä uudelleen.";
        await markConnection(connection.id, terminal, message);
        throw new EnableBankingError(message, 409, terminal === "revoked" ? "REVOKED_SESSION" : "EXPIRED_SESSION");
      }
      const message =
        error instanceof EnableBankingError ? publicBankError(error).message : "Tapahtumien haku epäonnistui.";
      failures.push(message);
      accounts.push({
        accountId: account.id,
        name: accountName(account),
        ok: false,
        imported: 0,
        skipped: 0,
        error: message,
      });
      console.error("Enable Banking account sync failed", {
        connectionId: connection.id,
        code: error instanceof EnableBankingError ? error.code : "unknown",
      });
    }
  }

  // What was left out. While anything is, lastSuccessAt stays where it was so
  // the next sync reads the same window again instead of the 5-day overlap.
  const notices: string[] = [];
  if (heldBack > 0) notices.push(heldBackNotice(heldBack));
  if (truncatedAccounts > 0) notices.push(PARTIAL_PULL_NOTICE);
  const notice = notices.length > 0 ? notices.join(" ") : null;

  if (succeeded === inScope.length && !notice) {
    await prisma.bankConnection.update({
      where: { id: connection.id },
      data: { lastSuccessAt: new Date(), lastError: null, status: "active" },
    });
  } else if (failures.length > 0 || notice) {
    await prisma.bankConnection.update({
      where: { id: connection.id },
      data: { lastError: failures[0] ?? notice },
    });
  }

  if (imported > 0) {
    await runMatching(userId).catch((error) => {
      console.error("Matching after bank sync failed", error);
    });
    for (const statementId of statementIds) {
      await autoGenerateIncomeReceipts(userId, statementId).catch((error) => {
        console.error("Income automation after bank sync failed", error);
      });
    }
  }

  if (succeeded === 0 && failures.length > 0) {
    throw new EnableBankingError(failures[0], 502);
  }

  const statementId = await newestStatementId([...statementIds]);
  return {
    connectionId: connection.id,
    status: "active",
    imported,
    skipped,
    statementId,
    statementIds: [...statementIds],
    accounts,
    heldBack,
    partial: notice !== null,
    notice,
  };
}

export async function syncDueBankConnections(now = new Date()): Promise<{
  processed: number;
  imported: number;
  skipped: number;
  errors: Array<{ connectionId: string; message: string }>;
}> {
  const connections = await prisma.bankConnection.findMany({
    where: { status: "active" },
    select: { id: true, userId: true, lastSyncAt: true, validUntil: true },
  });
  let imported = 0;
  let skipped = 0;
  const errors: Array<{ connectionId: string; message: string }> = [];
  let processed = 0;

  for (const connection of connections) {
    if (connection.validUntil && connection.validUntil.getTime() <= now.getTime()) {
      await markConnection(connection.id, "expired", "Yhteys vanhentui — yhdistä uudelleen.");
      continue;
    }
    if (!isBankSyncDue(connection.lastSyncAt, now)) {
      skipped += 1;
      continue;
    }
    const scoped = await prisma.connectedAccount.count({
      where: { connectionId: connection.id, inScope: true },
    });
    if (scoped === 0) {
      skipped += 1;
      continue;
    }
    processed += 1;
    try {
      const result = await syncBankConnection(connection.userId, connection.id, { attended: false });
      imported += result.imported;
    } catch (error) {
      errors.push({
        connectionId: connection.id,
        message:
          error instanceof EnableBankingError
            ? publicBankError(error).message
            : "Tapahtumien haku epäonnistui.",
      });
    }
  }

  return { processed, imported, skipped, errors };
}

async function writeTransactions(input: {
  userId: string;
  aspspName: string;
  rows: MappedBankTransaction[];
}): Promise<{ imported: number; skipped: number; heldBack: number; statementIds: string[] }> {
  if (input.rows.length === 0) return { imported: 0, skipped: 0, heldBack: 0, statementIds: [] };
  const uniqueRows = new Map<string, MappedBankTransaction>();
  for (const row of input.rows) uniqueRows.set(row.bankRef, row);
  const rows = [...uniqueRows.values()];
  // A row is known by its key, or by the key earlier syncs stored for it.
  const known = new Set<string>();
  const keys = rows.flatMap((row) => (row.legacyBankRef ? [row.bankRef, row.legacyBankRef] : [row.bankRef]));
  for (let index = 0; index < keys.length; index += 400) {
    const existing = await prisma.transaction.findMany({
      where: { userId: input.userId, bankRef: { in: keys.slice(index, index + 400) } },
      select: { bankRef: true },
    });
    for (const row of existing) {
      if (row.bankRef) known.add(row.bankRef);
    }
  }
  const unmatched = rows.filter(
    (row) => !known.has(row.bankRef) && !(row.legacyBankRef && known.has(row.legacyBankRef))
  );
  const notStored = await dropRowsAlreadyStoredByContent(input.userId, unmatched, known);
  const skipped = rows.length - notStored.length;

  // A closed month stays closed: its rows are not written and no sale draft
  // follows from them. They are not lost, because the caller keeps lastSuccessAt
  // where it was, so the next sync reads them again (and they are then deduped).
  const lockedThrough = await getLockedThrough(input.userId);
  const fallbackMonth = fallbackStatementMonth();
  const fresh = notStored.filter((row) =>
    row.date ? !isDateLocked(lockedThrough, row.date) : !isMonthLocked(lockedThrough, fallbackMonth)
  );
  const heldBack = notStored.length - fresh.length;
  if (fresh.length === 0) return { imported: 0, skipped, heldBack, statementIds: [] };

  const byMonth = new Map<string, MappedBankTransaction[]>();
  for (const row of fresh) {
    const month = row.date ? statementMonthOrFallback(row.date, fallbackMonth) : fallbackMonth;
    const bucket = byMonth.get(month) ?? [];
    bucket.push(row);
    byMonth.set(month, bucket);
  }

  const statementIds: string[] = [];
  let imported = 0;
  for (const [month, rows] of byMonth) {
    const statement = await ensureStatement(input.userId, rows[0].iban, month, input.aspspName);
    statementIds.push(statement.id);
    const data = rows.map((row) => ({
      statementId: statement.id,
      userId: input.userId,
      date: row.date ? new Date(`${row.date}T00:00:00.000Z`) : null,
      counterparty: row.counterparty,
      amountCents: row.amountCents,
      reference: row.reference,
      message: row.message,
      type: inferTransactionType(centsToEuros(row.amountCents), {
        counterparty: row.counterparty,
        message: row.message,
      }),
      bankRef: row.bankRef,
      source: "enablebanking",
      iban: row.iban,
    }));
    imported += await insertTransactions(data);
  }
  return { imported, skipped, heldBack, statementIds };
}

/**
 * The bank can change how it identifies a movement between two deliveries (a
 * reference that disappears or appears), which a key lookup alone reads as a
 * new row. So the rows the keys do not recognise are compared with what is
 * stored by content. A reference-less row is already stored when the database
 * holds at least as many rows with that content as this row's occurrence
 * number, and a row with a bank reference takes over the row an earlier sync
 * stored without one. Only as many rows are matched as exist, so a genuine
 * extra purchase is still new.
 */
async function dropRowsAlreadyStoredByContent(
  userId: string,
  unmatched: MappedBankTransaction[],
  knownKeys: Set<string>
): Promise<MappedBankTransaction[]> {
  if (unmatched.length === 0) return unmatched;
  const dates = unmatched.map((row) => row.date).filter((date): date is string => date !== null);
  const undated = unmatched.some((row) => row.date === null);
  const from = dates.reduce((min, date) => (date < min ? date : min), dates[0] ?? "");
  const to = dates.reduce((max, date) => (date > max ? date : max), dates[0] ?? "");
  const storedRows = await prisma.transaction.findMany({
    where: {
      userId,
      source: "enablebanking",
      iban: { in: [...new Set(unmatched.map((row) => row.iban))] },
      OR: [
        ...(dates.length > 0
          ? [{ date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } }]
          : []),
        ...(undated ? [{ date: null }] : []),
      ],
    },
    select: {
      id: true,
      bankRef: true,
      iban: true,
      date: true,
      amountCents: true,
      reference: true,
      message: true,
      counterparty: true,
    },
  });
  const byFingerprint = new Map<string, Array<{ id: string; bankRef: string | null }>>();
  for (const stored of storedRows) {
    const fingerprint = contentFingerprint({
      iban: stored.iban ?? "",
      date: stored.date ? stored.date.toISOString().slice(0, 10) : null,
      amountCents: stored.amountCents,
      reference: stored.reference,
      message: stored.message,
      counterparty: stored.counterparty,
    });
    const bucket = byFingerprint.get(fingerprint) ?? [];
    bucket.push({ id: stored.id, bankRef: stored.bankRef });
    byFingerprint.set(fingerprint, bucket);
  }

  const fresh: MappedBankTransaction[] = [];
  const claimed = new Set<string>();
  for (const row of unmatched) {
    const same = byFingerprint.get(row.fingerprint) ?? [];
    if (!row.stableRef) {
      if (same.length >= row.occurrence) continue;
      fresh.push(row);
      continue;
    }
    // A stable reference: adopt an earlier row that was stored without one and
    // that no row of this delivery already claims by its own key.
    const adoptable = same.find(
      (candidate) =>
        candidate.bankRef !== null &&
        isFingerprintRef(candidate.bankRef) &&
        !knownKeys.has(candidate.bankRef) &&
        !claimed.has(candidate.id)
    );
    if (!adoptable) {
      fresh.push(row);
      continue;
    }
    claimed.add(adoptable.id);
    await prisma.transaction.update({ where: { id: adoptable.id }, data: { bankRef: row.bankRef } });
  }
  return fresh;
}

async function ensureStatement(userId: string, iban: string, month: string, aspspName: string) {
  const checksum = `eb:${iban}:${month}`;
  // The owner's own account with this IBAN, when there is one: the tiliote then
  // counts towards that account instead of showing "Ei pankkitiliä". No
  // account is created here; one without an opening balance would report a
  // wrong balance and a false reconciliation gap.
  const account = await prisma.bankAccount.findFirst({
    where: { userId, iban: normalizeIban(iban) },
    select: { id: true },
  });
  const bankAccountId = account?.id ?? null;
  const found = await prisma.statement.findFirst({ where: { userId, checksum } });
  if (found) {
    if (bankAccountId && !found.bankAccountId) {
      return prisma.statement.update({ where: { id: found.id }, data: { bankAccountId } });
    }
    return found;
  }
  try {
    return await prisma.statement.create({
      data: {
        userId,
        bankAccountId,
        fileName: `${aspspName} ${formatIbanDisplay(iban)}`,
        fileType: "enablebanking",
        filePath: "enablebanking",
        checksum,
        periodMonth: month,
        periodSource: "auto",
      },
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const again = await prisma.statement.findFirst({ where: { userId, checksum } });
    if (again) return again;
    throw error;
  }
}

async function insertTransactions(
  data: Array<{
    statementId: string;
    userId: string;
    date: Date | null;
    counterparty: string | null;
    amountCents: number;
    reference: string | null;
    message: string | null;
    type: string;
    bankRef: string;
    source: string;
    iban: string;
  }>
): Promise<number> {
  const chunkSize = 40;
  let inserted = 0;
  for (let index = 0; index < data.length; index += chunkSize) {
    const chunk = data.slice(index, index + chunkSize);
    try {
      const result = await prisma.transaction.createMany({ data: chunk });
      inserted += result.count;
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      for (const row of chunk) {
        try {
          await prisma.transaction.create({ data: row });
          inserted += 1;
        } catch (rowError) {
          if (!isUniqueConflict(rowError)) throw rowError;
        }
      }
    }
  }
  return inserted;
}

async function newestStatementId(ids: string[]): Promise<string | null> {
  if (ids.length === 0) return null;
  const statements = await prisma.statement.findMany({
    where: { id: { in: ids } },
    select: { id: true, periodMonth: true },
  });
  statements.sort((a, b) => (b.periodMonth || "").localeCompare(a.periodMonth || ""));
  return statements[0]?.id ?? null;
}

async function markConnection(id: string, status: "expired" | "revoked" | "error", lastError: string) {
  await prisma.bankConnection.update({
    where: { id },
    data: {
      status,
      lastError,
      sessionIdEnc: status === "expired" || status === "revoked" ? null : undefined,
    },
  });
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}
