import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import {
  StatementParseError,
  parseCamtXML,
  parseXLSX,
  parseCSV,
  parsePDFStatement,
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
import { archivedAccountForIban, archivedAccountImportNotice, resolveAccountForImport } from "@/lib/bank-accounts";
import { extractOwnIban } from "@/lib/iban";
import { Prisma } from "@/generated/prisma/client";
import { loadStoredRowIdentities, lockedRowsNotice, skippedRowsNotice, splitNewRows } from "@/lib/bank-row-fingerprint";

import { PeriodLockedError, getLockedThrough, isMonthLocked } from "@/lib/period-lock";
import { fallbackStatementMonth } from "@/lib/report-calendar";
import { AppError } from "@/lib/api-errors";
function publicTransaction<T extends { amountCents: number }>(tx: T) {
  const { amountCents, ...rest } = tx;
  return { ...rest, amount: centsToEuros(amountCents) };
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
    // Only text formats are cheap to scan; xlsx/pdf have no IBAN hint.
    const scannable = detected.kind === "xml" || detected.kind === "csv";
    // The file's own account, never a counterparty's (a transfer to the owner's
    // other account names that account in the rows too).
    const ibanHint = scannable ? extractOwnIban(buffer.toString("utf8").slice(0, 200_000)) : null;
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

    const { statement, statements, skippedDuplicates, heldBack } = await prisma.$transaction(async (db) => {
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
    });

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
          error: "Kaikki tiedoston tapahtumat oli jo tuotu aiemmin, joten mitään ei lisätty.",
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
