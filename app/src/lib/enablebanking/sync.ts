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
  formatIbanDisplay,
  mapBookedTransaction,
  pickBookedBalance,
  type MappedBankTransaction,
} from "./mapping";
import type { PsuContext } from "./client";
import { withTrackedJob } from "../job-tracker";

const DEAD_SESSION_STATUS = new Set(["EXPIRED", "CLOSED", "REVOKED", "CANCELLED", "INVALID"]);

export interface BankSyncResult {
  connectionId: string;
  status: string;
  imported: number;
  skipped: number;
  statementId: string | null;
  statementIds: string[];
}

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
  let succeeded = 0;

  for (const account of inScope) {
    try {
      const transactions = await collectAccountTransactions(client, {
        accountUid: account.providerAccountUid,
        firstSync,
        dateFrom,
        psuHeaders,
      });
      const mapped = transactions
        .map((tx) => mapBookedTransaction(tx, account.iban))
        .filter((tx): tx is MappedBankTransaction => tx !== null);
      const written = await writeTransactions({
        userId,
        aspspName: connection.aspspName,
        rows: mapped,
      });
      imported += written.imported;
      skipped += written.skipped;
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
      console.error("Enable Banking account sync failed", {
        connectionId: connection.id,
        code: error instanceof EnableBankingError ? error.code : "unknown",
      });
    }
  }

  if (succeeded === inScope.length) {
    await prisma.bankConnection.update({
      where: { id: connection.id },
      data: { lastSuccessAt: new Date(), lastError: null, status: "active" },
    });
  } else if (failures.length > 0) {
    await prisma.bankConnection.update({
      where: { id: connection.id },
      data: { lastError: failures[0] },
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
}): Promise<{ imported: number; skipped: number; statementIds: string[] }> {
  if (input.rows.length === 0) return { imported: 0, skipped: 0, statementIds: [] };
  const uniqueRows = new Map<string, MappedBankTransaction>();
  for (const row of input.rows) uniqueRows.set(row.bankRef, row);
  const rows = [...uniqueRows.values()];
  const known = new Set<string>();
  for (let index = 0; index < rows.length; index += 400) {
    const slice = rows.slice(index, index + 400).map((row) => row.bankRef);
    const existing = await prisma.transaction.findMany({
      where: { userId: input.userId, bankRef: { in: slice } },
      select: { bankRef: true },
    });
    for (const row of existing) {
      if (row.bankRef) known.add(row.bankRef);
    }
  }
  const fresh = rows.filter((row) => !known.has(row.bankRef));
  const skipped = rows.length - fresh.length;
  if (fresh.length === 0) return { imported: 0, skipped, statementIds: [] };

  const byMonth = new Map<string, MappedBankTransaction[]>();
  const fallbackMonth = new Date().toISOString().slice(0, 7);
  for (const row of fresh) {
    const month = row.date?.slice(0, 7) || fallbackMonth;
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
  return { imported, skipped, statementIds };
}

async function ensureStatement(userId: string, iban: string, month: string, aspspName: string) {
  const checksum = `eb:${iban}:${month}`;
  const found = await prisma.statement.findFirst({ where: { userId, checksum } });
  if (found) return found;
  try {
    return await prisma.statement.create({
      data: {
        userId,
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
