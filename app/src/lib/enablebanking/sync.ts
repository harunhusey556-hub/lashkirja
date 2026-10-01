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
import { BANK_SYNC_OVERLAP_DAYS, isBankSyncDue, overlapDateFrom } from "./consent";
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
import { adoptStatementsByIban } from "../bank-accounts";
import { CONSENT_REVOKED_MESSAGE } from "../bank-consent-copy";
import { StoredRowPool } from "../bank-row-fingerprint";
import { fallbackStatementMonth, statementMonthOrFallback } from "../report-calendar";
import {
  PARTIAL_PULL_NOTICE,
  SHORTENED_NOTICE_START,
  heldBackNotice,
  shortenedNotice,
  type AccountSyncRow,
} from "../bank-sync-summary";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEAD_SESSION_STATUS =new Set(["EXPIRED", "CLOSED", "REVOKED", "CANCELLED", "INVALID"]);

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
  /** True when something was left out or the history is shorter than asked for. */
  partial: boolean;
  /** The plain-language reason, the same text the connection card shows. */
  notice: string | null;
}

// The sentences live with the screens that show them.
export { PARTIAL_PULL_NOTICE, heldBackNotice };

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
  // An account the owner added after earlier syncs claims those statements now,
  // also when this sync brings nothing new (statements are otherwise linked only
  // when a row is written).
  await claimStatementsOfOwnAccounts(userId, inScope.map((account) => account.iban));

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

  let remoteStatus: string | undefined;
  try {
    remoteStatus = (await client.getSession(sessionId)).status;
  } catch (error) {
    const terminal = sessionTerminalStatus(error);
    if (terminal) throw await endConsent(connection.id, terminal === "revoked");
    if (error instanceof EnableBankingError && (error.status === 401 || error.status === 403)) {
      // Said in plain Finnish here, so neither the answer nor the job log
      // carries the provider's own English.
      throw new EnableBankingError(publicBankError(error).message, error.status, error.code);
    }
    console.error("Enable Banking session check failed", {
      connectionId: connection.id,
      code: error instanceof EnableBankingError ? error.code : "unknown",
    });
  }
  if (remoteStatus && DEAD_SESSION_STATUS.has(remoteStatus)) {
    throw await endConsent(connection.id, remoteStatus === "REVOKED");
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
  /** The first bank-side failure, so the answer keeps its meaning (a 429 stays a 429). */
  let firstFailure: EnableBankingError | null = null;
  const accounts: BankSyncAccountRow[] = [];
  let succeeded = 0;
  let truncatedAccounts = 0;
  let heldBack = 0;
  let earliestHeld: string | null = null;
  /** The shortest window a bank gave on this sync, in days. */
  let shortenedDays: number | null = null;

  const accountName = (account: { label: string | null; iban: string }) => {
    const label = account.label?.trim();
    const iban = formatIbanDisplay(account.iban);
    return label ? `${label} ${iban}` : iban;
  };

  for (const account of inScope) {
    try {
      const { transactions, truncated, shortenedFrom } = await collectAccountTransactions(client, {
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
      if (written.earliestHeld && (!earliestHeld || written.earliestHeld < earliestHeld)) {
        earliestHeld = written.earliestHeld;
      }
      if (shortenedFrom) {
        const since = new Date(`${shortenedFrom}T00:00:00.000Z`).getTime();
        const days = Math.max(1, Math.round((Date.now() - since) / DAY_MS));
        shortenedDays = shortenedDays === null ? days : Math.min(shortenedDays, days);
      }
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
      if (terminal) throw await endConsent(connection.id, terminal === "revoked");
      const message =
        error instanceof EnableBankingError ? publicBankError(error).message : "Tapahtumien haku epäonnistui.";
      failures.push(message);
      if (!firstFailure && error instanceof EnableBankingError) firstFailure = error;
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

  // What was left out. The owner is always told (the notice is the connection's
  // lastError, shown as a calm note) and the sync does not look finished:
  // - a pull that ended short keeps lastSuccessAt, so the next sync reads the
  //   same window again;
  // - rows of a closed month are held back, and lastSuccessAt moves only up to
  //   the oldest of them. The connection stays an ordinary incremental one
  //   (never the open-ended first sync again, which a wedge of held rows used
  //   to cause) and the held rows are read again until their month is reopened;
  // - a window the bank shortened is said, and kept as a note on later syncs,
  //   because the older history can only come from a tiliote file.
  const notices: string[] = [];
  if (heldBack > 0) notices.push(heldBackNotice(heldBack));
  if (truncatedAccounts > 0) notices.push(PARTIAL_PULL_NOTICE);
  if (shortenedDays !== null) notices.push(shortenedNotice(shortenedDays));
  const notice = notices.length > 0 ? notices.join(" ") : null;
  const keptShortened =
    !firstSync && connection.lastError?.startsWith(SHORTENED_NOTICE_START) ? connection.lastError : null;

  if (succeeded === inScope.length && truncatedAccounts === 0) {
    const now = Date.now();
    const watermark = earliestHeld
      ? Math.min(now, new Date(`${earliestHeld}T00:00:00.000Z`).getTime() + BANK_SYNC_OVERLAP_DAYS * DAY_MS)
      : now;
    await prisma.bankConnection.update({
      where: { id: connection.id },
      data: { lastSuccessAt: new Date(watermark), lastError: notice ?? keptShortened, status: "active" },
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
    // The sentence is already the calm one; the status and code are the bank's
    // own, so the answer maps to the very same sentence (a request to wait is
    // not told as a general failure) and the card does not repeat it twice.
    throw new EnableBankingError(failures[0], firstFailure?.status ?? 502, firstFailure?.code);
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
    // A closed account's bank connection is not pulled again (F57).
    where: { status: "active", user: { accessDisabledAt: null } },
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
}): Promise<{
  imported: number;
  skipped: number;
  heldBack: number;
  /** The oldest day among the rows held back ("YYYY-MM-DD"), when any were. */
  earliestHeld: string | null;
  statementIds: string[];
}> {
  if (input.rows.length === 0) {
    return { imported: 0, skipped: 0, heldBack: 0, earliestHeld: null, statementIds: [] };
  }
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
  const freshRows = new Set(fresh);
  const heldRows = notStored.filter((row) => !freshRows.has(row));
  const heldBack = heldRows.length;
  const earliestHeld = heldRows.reduce<string | null>(
    (min, row) => (row.date && (!min || row.date < min) ? row.date : min),
    null
  );
  if (fresh.length === 0) return { imported: 0, skipped, heldBack, earliestHeld, statementIds: [] };

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
  return { imported, skipped, heldBack, earliestHeld, statementIds };
}

/**
 * The bank can change how it identifies a movement between two deliveries (a
 * reference that disappears, appears or is replaced by another id), and the
 * same movements may already be stored from a tiliote file. A key lookup alone
 * reads all of that as new rows, so the rows the keys do not recognise are
 * compared with what the account already holds, from any statement and any
 * source, in two passes. Rows are claimed one stored row at a time, so only as
 * many are matched as exist and a genuine extra purchase is still new.
 *
 * 1. Same content (date, cents and the bank's own wording): a row with a
 *    stable id takes over the stored row's key; a row without one is skipped.
 * 2. Same day, cents and counterparty (what a file shares with the feed, or
 *    what is left when a reference number vanished): a file row takes over the
 *    bank's key, a bank row stored under a fingerprint key likewise.
 *
 * A stored row whose key this delivery carries itself is never claimed.
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
  const ibans = [...new Set(unmatched.map((row) => row.iban))];
  // The account an IBAN belongs to: a tiliote file imported for it holds the
  // same movements without any IBAN of its own.
  const accounts = await prisma.bankAccount.findMany({
    where: { userId, iban: { in: ibans } },
    select: { id: true },
  });
  const storedRows = await prisma.transaction.findMany({
    where: {
      AND: [
        {
          OR: [
            { userId, iban: { in: ibans } },
            ...(accounts.length > 0
              ? [{ statement: { userId, bankAccountId: { in: accounts.map((account) => account.id) } } }]
              : []),
          ],
        },
        {
          OR: [
            ...(dates.length > 0
              ? [{ date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } }]
              : []),
            ...(undated ? [{ date: null }] : []),
          ],
        },
      ],
    },
    select: {
      id: true,
      bankRef: true,
      source: true,
      iban: true,
      date: true,
      amountCents: true,
      reference: true,
      message: true,
      counterparty: true,
    },
  });
  type Stored = (typeof storedRows)[number] & { day: string | null };
  const claimable: Stored[] = storedRows
    .filter((stored) => !(stored.bankRef && knownKeys.has(stored.bankRef)))
    .map((stored) => ({ ...stored, day: stored.date ? stored.date.toISOString().slice(0, 10) : null }));

  const byFingerprint = new Map<string, Stored[]>();
  for (const stored of claimable) {
    if (stored.source !== "enablebanking" || !stored.iban) continue;
    const fingerprint = contentFingerprint({
      iban: stored.iban,
      date: stored.day,
      amountCents: stored.amountCents,
      reference: stored.reference,
      message: stored.message,
      counterparty: stored.counterparty,
    });
    const bucket = byFingerprint.get(fingerprint) ?? [];
    bucket.push(stored);
    byFingerprint.set(fingerprint, bucket);
  }

  const claimed = new Set<string>();
  const adopt = async (stored: Stored, row: MappedBankTransaction) => {
    claimed.add(stored.id);
    // A row that lost its id does not replace the stored row's own key.
    if (!row.stableRef && stored.bankRef) return;
    if (stored.bankRef === row.bankRef && stored.iban === row.iban) return;
    await prisma.transaction.update({
      where: { id: stored.id },
      data: { bankRef: row.bankRef, iban: row.iban, userId },
    });
  };

  // Pass 1: the same content.
  const leftOver: MappedBankTransaction[] = [];
  for (const row of unmatched) {
    const same = byFingerprint.get(row.fingerprint)?.find((candidate) => !claimed.has(candidate.id));
    if (!same) {
      leftOver.push(row);
      continue;
    }
    await adopt(same, row);
  }

  // Pass 2: the same day, cents and counterparty.
  const pool = new StoredRowPool(
    claimable
      .filter((stored) => !claimed.has(stored.id))
      .map((stored) => ({
        date: stored.day,
        amountCents: stored.amountCents,
        counterparty: stored.counterparty,
        stored,
      }))
  );
  const fresh: MappedBankTransaction[] = [];
  for (const row of leftOver) {
    const hit = pool.take(row, (candidate) => {
      const { stored } = candidate;
      // Two bank rows with ids of their own are different movements unless
      // their content says otherwise (pass 1). A bank row stored under a
      // fingerprint key, a row stored by file and a row that lost its id may
      // still be the same movement.
      if (stored.source !== "enablebanking") return true;
      if (!row.stableRef) return true;
      return stored.bankRef !== null && isFingerprintRef(stored.bankRef);
    });
    if (!hit) {
      fresh.push(row);
      continue;
    }
    await adopt(hit.stored, row);
  }
  return fresh;
}

async function claimStatementsOfOwnAccounts(userId: string, ibans: string[]) {
  for (const iban of new Set(ibans.map((value) => normalizeIban(value)))) {
    const account = await prisma.bankAccount.findFirst({ where: { userId, iban, archivedAt: null }, select: { id: true } });
    if (account) await adoptStatementsByIban(userId, account.id, iban);
  }
}

async function ensureStatement(userId: string, iban: string, month: string, aspspName: string) {
  const checksum = `eb:${iban}:${month}`;
  // The owner's own account with this IBAN, when there is one: the tiliote then
  // counts towards that account instead of showing "Ei pankkitiliä". No
  // account is created here; one without an opening balance would report a
  // wrong balance and a false reconciliation gap.
  const account = await prisma.bankAccount.findFirst({
    where: { userId, iban: normalizeIban(iban), archivedAt: null },
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

/**
 * The bank no longer honours the session. Both ways a bank can say so (an error
 * code, or a session status) end the same: "expired", visible, with the reason,
 * so the owner can confirm again. "revoked" stays the owner's own Katkaise and
 * is never written from here; a hidden status would make the connection vanish.
 */
async function endConsent(id: string, withdrawn: boolean): Promise<EnableBankingError> {
  const message = withdrawn ? CONSENT_REVOKED_MESSAGE : "Yhteys vanhentui — yhdistä uudelleen.";
  await markConnection(id, "expired", message);
  return new EnableBankingError(message, 409, withdrawn ? "REVOKED_SESSION" : "EXPIRED_SESSION");
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
