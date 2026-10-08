import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import {
  StatementParseError,
  parseCamtXML,
  parseXLSX,
  parseCSV,
  parsePDFStatement,
  derivedMonthEndBalances,
  monthEndBalances,
  parsePrintedBalances,
  type PrintedBalance,
  statementHeaderText,
} from "@/lib/parsers";
import {
  MAX_STATEMENT_BYTES,
  UploadValidationError,
  removeUserUpload,
  sha256,
  validateUploadBuffer,
  writePrivateUpload,
} from "@/lib/storage";
import { rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { runMatching } from "@/lib/matching";
import { eurosToCents } from "@/lib/money";
import { inferTransactionType } from "@/lib/statements";
import { listStatementsForUser } from "@/lib/statement-api";
import { centsToEuros } from "@/lib/money";
import { autoGenerateIncomeReceipts } from "@/lib/income-automation";
import { archivedAccountForIban, archivedAccountImportNotice, resolveAccountForImport, upsertMonthlyBalance } from "@/lib/bank-accounts";
import { extractOwnIban, isValidIban, normalizeIban } from "@/lib/iban";
import { Prisma } from "@/generated/prisma/client";
import { loadStoredRowIdentities, lockedRowsNotice, skippedRowsNotice, splitNewRows } from "@/lib/bank-row-fingerprint";

import { PeriodLockedError, getLockedThrough, isMonthLocked } from "@/lib/period-lock";
import { fallbackStatementMonth } from "@/lib/report-calendar";
import { AppError } from "@/lib/api-errors";
function publicTransaction<T extends { amountCents: number }>(tx: T) {
  const { amountCents, ...rest } = tx;
  return { ...rest, amount: centsToEuros(amountCents) };
}

/**
 * Balances the statement prints become the account's month-end balances, so its saldo is the
 * bank's and not one counted up from an opening balance of 0 (2026-10-09, Holvi PDF). One the
 * owner entered stays; a month that cannot take one (closed, before the account) is skipped.
 */
async function recordPrintedBalances(
  userId: string,
  bankAccountId: string | null,
  headerText: string | null,
  rows: Array<{ date: string | null; amount: number }>,
  fileName: string,
  ibanHint: string | null = null
): Promise<number> {
  if (!bankAccountId || !headerText) return 0;
  const printed = parsePrintedBalances(headerText);
  await fitAccountToStatement(userId, bankAccountId, printed, rows, ibanHint);
  // Printed month ends first; the ones counted from the opening and closing balance fill in.
  const ends = new Map(derivedMonthEndBalances(printed, rows).map((row) => [row.month, row.closingBalance]));
  for (const row of monthEndBalances(printed)) ends.set(row.month, row.closingBalance);
  let stored = 0;
  for (const [month, closingBalance] of ends) {
    const existing = await prisma.monthlyBalance.findUnique({
      where: { bankAccountId_month: { bankAccountId, month } },
      select: { source: true },
    });
    if (existing?.source === "manual") continue;
    await upsertMonthlyBalance(userId, bankAccountId, { month, closingBalance, source: "statement", note: fileName.slice(0, 200) })
      .then(() => { stored += 1; })
      .catch((e: unknown) => console.warn(`Statement upload: month-end balance ${month} not stored:`, e instanceof Error ? e.message : e));
  }
  return stored;
}

/**
 * A statement that reaches back before its account fits the account to itself, when the account
 * is still as the app made it: opening balance 0 (never entered by the owner) and no stored row
 * dated before the statement starts. Then:
 * - the opening date moves back to the statement's first day (the first printed SALDO, else the
 *   first row), because an account added in the app gets today as its opening date and every
 *   month-end balance and row before it was refused (prod 2026-10-09: "Kuukausi on ennen tilin
 *   avauspäivää" for June-September of a Holvi statement uploaded on 9.10.);
 * - the opening balance becomes the statement's first printed SALDO (Holvi "SALDO 5.6. +83,01");
 * - an account without an IBAN takes the file's own IBAN, if no other account of the user has it.
 * An opening balance the owner set is their decision and is never changed.
 */
async function fitAccountToStatement(
  userId: string,
  bankAccountId: string,
  printed: PrintedBalance[],
  rows: Array<{ date: string | null }>,
  ibanHint: string | null
) {
  const account = await prisma.bankAccount.findFirst({
    where: { id: bankAccountId, userId },
    select: { openingBalanceCents: true, openingDate: true, iban: true },
  });
  if (!account || account.openingBalanceCents !== 0) return;
  const first = [...printed].sort((a, b) => a.date.localeCompare(b.date))[0];
  const firstRowDay = rows.map((row) => row.date).filter((d): d is string => Boolean(d)).sort()[0];
  const startDay = first?.date ?? firstRowDay;
  const data: { openingDate?: Date; openingBalanceCents?: number; iban?: string } = {};
  if (startDay) {
    const startsAt = new Date(`${startDay}T00:00:00.000Z`);
    const earlier = await prisma.transaction.count({
      where: { statement: { bankAccountId }, date: { lt: startsAt } },
    });
    if (earlier === 0) {
      if (startsAt < account.openingDate) data.openingDate = startsAt;
      if (first && first.date === startDay && first.balance !== 0) data.openingBalanceCents = eurosToCents(first.balance);
    }
  }
  if (!account.iban && ibanHint) {
    const iban = normalizeIban(ibanHint);
    const taken = isValidIban(iban) && (await prisma.bankAccount.findFirst({ where: { userId, iban }, select: { id: true } }));
    if (isValidIban(iban) && !taken) data.iban = iban;
  }
  if (Object.keys(data).length === 0) return;
  await prisma.bankAccount.update({ where: { id: bankAccountId }, data });
}

/** Most common YYYY-MM among the rows' dates; the fallback when none has a date. */
function dominantMonth(rows: Array<{ date: string | null }>, fallback: string): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.date) continue;
    const month = row.date.slice(0, 7);
    counts.set(month, (counts.get(month) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || fallback;
}

/** One sentence for the owner when a file crossed a month boundary and was stored per month. */
function splitNotice(months: number): string | null {
  return months > 1 ? `Tiedostossa oli tapahtumia ${months} kuukaudelta, joten ne tallennettiin kuukausittain.` : null;
}

/** Every row of the file is already stored (an overlapping or repeated export). */
class AllRowsKnownError extends Error {
  /** Month-end balances the file still brought (see recordPrintedBalances). */
  balancesStored = 0;
  constructor(readonly skipped: number) {
    super("all rows already stored");
  }
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }
  const userId = session.userId;

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(
    req,
    MAX_STATEMENT_BYTES + 1024 * 1024
  );
  if (oversized) return oversized;

  let storageKey: string | null = null;
  let checksum: string | null = null;
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json(
        { error: "Tiedosto puuttuu" },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    // An empty file is the user's mistake, not an oversized payload (413).
    if (buffer.length === 0) {
      return NextResponse.json({ error: "Tiedosto on tyhjä" }, { status: 400 });
    }

    // Content-sniffed, not extension-trusted. The old code chose a parser from
    // the client-supplied filename and wrote unbounded bytes into a directory
    // shared by every user. Receipts already went through this validation;
    // statements did not.
    const detected = validateUploadBuffer(buffer, file.name, "statement");

    // Statement.checksum has been unique-per-user in the schema from the start,
    // but nothing ever populated it, so it stayed null and the same tiliote
    // could be imported repeatedly, duplicating every transaction inside it.
    const fileChecksum = sha256(buffer);
    checksum = fileChecksum;
    const duplicate = await prisma.statement.findFirst({
      where: { userId, checksum: fileChecksum },
      select: { id: true },
    });
    // A file seen before is not refused outright: rows held back from a month
    // that was closed then may be importable now. The row identities below
    // decide; a file with nothing new still gets the "already imported" 409.
    // The repeat needs its own checksum, as Statement.checksum is unique.
    const statementChecksum = duplicate ? `${fileChecksum}:again:${Date.now().toString(36)}` : fileChecksum;

    const written = await writePrivateUpload(userId, detected.extension, buffer);
    storageKey = written.storageKey;
    const filePath = written.absolutePath;

    let fileType = "unknown";
    let parsedTransactions;

    if (detected.kind === "xml") {
      fileType = "camt-xml";
      parsedTransactions = await parseCamtXML(filePath);
    } else if (detected.kind === "xlsx" || detected.kind === "xls") {
      fileType = "xlsx";
      parsedTransactions = await parseXLSX(filePath);
    } else if (detected.kind === "csv") {
      fileType = "csv";
      parsedTransactions = await parseCSV(filePath);
    } else if (detected.kind === "pdf") {
      fileType = "pdf";
      parsedTransactions = await parsePDFStatement(filePath);
    } else {
      return NextResponse.json(
        { error: "Tuntematon tiedostomuoto" },
        { status: 400 }
      );
    }

    // The month and the lock are decided from the rows that are really
    // stored (below), after the rows already known are taken out. For now the
    // statement gets the month of the whole file.
    const fallbackMonth = fallbackStatementMonth();
    const provisionalMonth = dominantMonth(parsedTransactions, fallbackMonth);

    // File the upload under a bank account: an explicit choice from the form
    // wins, then an IBAN found inside the file, then the default account.
    const requestedAccountId = formData.get("bankAccountId");
    let bankAccountId: string | null = null;
    let accountNotice: string | null = null;
    // What the file says about itself: text formats as they are, a PDF's text and an xlsx's first
    // rows (a Holvi export names its IBAN in row 1 and prints SALDO lines in its PDF).
    const scannable = detected.kind === "xml" || detected.kind === "csv";
    const headerText = scannable ? buffer.toString("utf8").slice(0, 200_000) : await statementHeaderText(detected.kind, filePath);
    // The file's own account, never a counterparty's (a transfer to the owner's
    // other account names that account in the rows too).
    const ibanHint = headerText ? extractOwnIban(headerText) : null;
    if (typeof requestedAccountId === "string" && requestedAccountId.trim()) {
      const owned = await prisma.bankAccount.findFirst({
        where: { id: requestedAccountId.trim(), userId },
        select: { id: true },
      });
      if (!owned) {
        // Nothing was stored for this upload: the bytes go too.
        await removeUserUpload(userId, storageKey!).catch(() => {});
        return NextResponse.json(
          { error: "Pankkitiliä ei löytynyt" },
          { status: 404 }
        );
      }
      bankAccountId = owned.id;
    } else {
      bankAccountId = await resolveAccountForImport(userId, { iban: ibanHint });
      // M1-4: the file's own account is archived, so it was filed under none; say so.
      if (bankAccountId === null) {
        const archivedHolder = await archivedAccountForIban(userId, ibanHint);
        if (archivedHolder) accountNotice = archivedAccountImportNotice(archivedHolder.name);
      }
    }

    const imported = await prisma.$transaction(async (db) => {
      // The statement is written first: that takes SQLite's write lock, so the
      // stored rows read below cannot change under a concurrent import.
      const created = await db.statement.create({
        data: {
          userId,
          bankAccountId,
          fileName: file.name,
          fileType,
          filePath: storageKey!,
          checksum: statementChecksum,
          periodMonth: provisionalMonth,
          periodSource: "auto",
        },
      });
      const incoming = parsedTransactions.map((tx) => ({ ...tx, amountCents: eurosToCents(tx.amount) }));
      // The file hash only catches a byte-identical file. An export that
      // overlaps an earlier one, or the bank feed, repeats rows under new ids.
      const account = bankAccountId
        ? await db.bankAccount.findUnique({ where: { id: bankAccountId }, select: { iban: true } })
        : null;
      const stored = await loadStoredRowIdentities(db, userId, bankAccountId, incoming, [account?.iban, ibanHint]);
      const { fresh, duplicates } = splitNewRows(incoming, stored);
      if (fresh.length === 0) throw new AllRowsKnownError(duplicates.length);

      // A closed month stays closed, for every row and not only for the month
      // the file is mostly about: rows dated in it are left out, and a file
      // with nothing else to store is refused.
      const lockedThrough = await getLockedThrough(userId, db);
      const isLocked = (tx: { date: string | null }) =>
        isMonthLocked(lockedThrough, tx.date ? tx.date.slice(0, 7) : fallbackMonth);
      const open = fresh.filter((tx) => !isLocked(tx));
      if (open.length === 0) {
        const month = fresh[0].date ? fresh[0].date.slice(0, 7) : fallbackMonth;
        throw new PeriodLockedError(month, lockedThrough!);
      }
      // A row belongs to the month of its own date: a file that crosses a month
      // boundary is stored as one tiliote per month, so every screen that reads
      // a statement's month (Pankki, Koti, the VAT figures, the account's
      // balances) reads the same month for the same row. The month most rows
      // belong to keeps the file's own checksum, so the same file is refused as
      // already imported; a row without a date goes with that month.
      const periodMonth = dominantMonth(open, fallbackMonth);
      const labelled =
        periodMonth === provisionalMonth
          ? created
          : await db.statement.update({ where: { id: created.id }, data: { periodMonth } });
      const byMonth = new Map<string, typeof open>();
      for (const tx of open) {
        const month = tx.date ? tx.date.slice(0, 7) : periodMonth;
        byMonth.set(month, [...(byMonth.get(month) ?? []), tx]);
      }
      const made = [labelled];
      for (const month of byMonth.keys()) {
        if (month === periodMonth) continue;
        made.push(
          await db.statement.create({
            data: {
              userId,
              bankAccountId,
              fileName: file.name,
              fileType,
              filePath: storageKey!,
              checksum: `${statementChecksum}:${month}`,
              periodMonth: month,
              periodSource: "auto",
            },
          })
        );
      }
      const statementOf = new Map(made.map((item) => [item.periodMonth, item.id]));
      await db.transaction.createMany({
        data: open.map((tx) => ({
          statementId: statementOf.get(tx.date ? tx.date.slice(0, 7) : periodMonth)!,
          userId,
          source: "file",
          date: tx.date ? new Date(tx.date) : null,
          counterparty: tx.counterparty,
          amountCents: tx.amountCents,
          reference: tx.reference,
          message: tx.message,
          type: inferTransactionType(tx.amount, {
            counterparty: tx.counterparty,
            message: tx.message,
          }),
        })),
      });
      return { statement: labelled, statements: made, skippedDuplicates: duplicates.length, heldBack: fresh.length - open.length };
    }).catch(async (error: unknown) => {
      // A file already imported can still bring the balances it prints (an upload from before
      // they were read, 2026-10-09): they are stored, and the 409 says so.
      if (error instanceof AllRowsKnownError) {
        error.balancesStored = await recordPrintedBalances(userId, bankAccountId, headerText, parsedTransactions, file.name, ibanHint);
      }
      throw error;
    });
    const { statement, statements, skippedDuplicates, heldBack } = imported;

    await recordPrintedBalances(userId, bankAccountId, headerText, parsedTransactions, file.name, ibanHint);

    // Fetch recent emails from connected accounts before matching so that
    // any new emailed receipts can be matched to this statement immediately.
    try {
      const { syncImapAccount } = await import("@/lib/mail-sync");
      const imapAccounts = await prisma.imapAccount.findMany({ where: { userId } });
      await Promise.all(
        imapAccounts.map(account =>
          syncImapAccount(account.id).catch((e: unknown) =>
            console.error(`Statement upload: email sync failed for ${account.email}:`, e)
          )
        )
      );
    } catch (e: unknown) {
      console.error("Failed to sync emails during statement upload:", e);
    }

    await runMatching(userId).catch((e: unknown) =>
      console.error("Matching after statement upload failed:", e)
    );

    // Drafts pending sales receipts for recognised settlement providers only.
    // Nothing here is approved or linked automatically.
    for (const made of statements) {
      await autoGenerateIncomeReceipts(userId, made.id).catch((e) =>
        console.error("Income draft generation failed:", e)
      );
    }

    const transactions = await prisma.transaction.findMany({
      where: { statementId: { in: statements.map((made) => made.id) } },
      orderBy: { date: "asc" },
    });

    return NextResponse.json({
      ok: true,
      statement,
      // The tiliotteet this file became, one per month (additive; `statement` is the main one).
      statements,
      transactions: transactions.map(publicTransaction),
      count: transactions.length,
      skippedDuplicates,
      heldBack,
      notice:
        [accountNotice, splitNotice(statements.length), skippedRowsNotice(skippedDuplicates), lockedRowsNotice(heldBack)]
          .filter(Boolean)
          .join(" ") || null,
    });
  } catch (e) {
    // A rejected or unparseable upload must not leave bytes on disk.
    if (storageKey) {
      await removeUserUpload(userId, storageKey).catch(() => {});
    }
    if (e instanceof UploadValidationError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    if (e instanceof AllRowsKnownError) {
      return NextResponse.json(
        {
          error:
            e.balancesStored > 0
              ? "Kaikki tiedoston tapahtumat oli jo tuotu aiemmin, joten tapahtumia ei lisätty. Tiliotteen saldot päivitettiin tilille."
              : "Kaikki tiedoston tapahtumat oli jo tuotu aiemmin, joten mitään ei lisätty.",
          skippedDuplicates: e.skipped,
        },
        { status: 409 }
      );
    }
    // The same file arriving twice at once (double tap, two devices): both pass
    // the check above, the unique index lets one create the statement. The other
    // gets the answer a sequential repeat would have got.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002" &&
      checksum
    ) {
      const winner = await prisma.statement.findFirst({
        where: { userId, checksum },
        select: { id: true, fileName: true },
      });
      if (winner) {
        return NextResponse.json(
          {
            error: `Tämä tiliote on jo tuotu aiemmin (${winner.fileName}).`,
            statementId: winner.id,
          },
          { status: 409 }
        );
      }
    }
    // A file the parser could read but not use: its own Finnish reason, a user
    // problem and not a server fault. (The temp directory failure is ours.)
    if (e instanceof StatementParseError && e.code !== "TEMP_DIR_FAILED") {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 422 });
    }
    // A closed period is a deliberate refusal, not a server fault.
    if (e instanceof AppError) {
      return NextResponse.json(
        { error: { code: e.code, message: e.message } },
        { status: e.statusCode }
      );
    }
    console.error("Statement upload error:", e);
    return NextResponse.json(
      { error: "Tiedoston käsittely epäonnistui" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const month = new URL(req.url).searchParams.get("month");
  const statements = await listStatementsForUser(session.userId, month);
  return NextResponse.json({ statements });
}
