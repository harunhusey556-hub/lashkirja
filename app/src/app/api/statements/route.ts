import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import {
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

function publicTransaction<T extends { amountCents: number }>(tx: T) {
  const { amountCents, ...rest } = tx;
  return { ...rest, amount: centsToEuros(amountCents) };
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

    // Content-sniffed, not extension-trusted. The old code chose a parser from
    // the client-supplied filename and wrote unbounded bytes into a directory
    // shared by every user. Receipts already went through this validation;
    // statements did not.
    const detected = validateUploadBuffer(buffer, file.name, "statement");

    // Statement.checksum has been unique-per-user in the schema from the start,
    // but nothing ever populated it, so it stayed null and the same tiliote
    // could be imported repeatedly, duplicating every transaction inside it.
    const checksum = sha256(buffer);
    const duplicate = await prisma.statement.findFirst({
      where: { userId, checksum },
      select: { id: true, fileName: true },
    });
    if (duplicate) {
      return NextResponse.json(
        {
          error: `Tämä tiliote on jo tuotu aiemmin (${duplicate.fileName}).`,
          statementId: duplicate.id,
        },
        { status: 409 }
      );
    }

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

    // Most common YYYY-MM among parsed dates; fall back to upload month
    const monthCounts = new Map<string, number>();
    for (const tx of parsedTransactions) {
      if (tx.date) {
        const month = tx.date.slice(0, 7);
        monthCounts.set(month, (monthCounts.get(month) || 0) + 1);
      }
    }
    const periodMonth =
      [...monthCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
      new Date().toISOString().slice(0, 7);

    const statement = await prisma.$transaction(async (db) => {
      const created = await db.statement.create({
        data: {
          userId,
          fileName: file.name,
          fileType,
          filePath: storageKey!,
          checksum,
          periodMonth,
          periodSource: "auto",
        },
      });
      await db.transaction.createMany({
        data: parsedTransactions.map((tx) => ({
          statementId: created.id,
          date: tx.date ? new Date(tx.date) : null,
          counterparty: tx.counterparty,
          amountCents: eurosToCents(tx.amount),
          reference: tx.reference,
          message: tx.message,
          type: inferTransactionType(tx.amount, {
            counterparty: tx.counterparty,
            message: tx.message,
          }),
        })),
      });
      return created;
    });

    await runMatching(userId).catch((e) =>
      console.error("Matching after statement upload failed:", e)
    );

    // Drafts pending sales receipts for recognised settlement providers only.
    // Nothing here is approved or linked automatically.
    await autoGenerateIncomeReceipts(userId, statement.id).catch((e) =>
      console.error("Income draft generation failed:", e)
    );

    const transactions = await prisma.transaction.findMany({
      where: { statementId: statement.id },
      orderBy: { date: "asc" },
    });

    return NextResponse.json({
      ok: true,
      statement,
      transactions: transactions.map(publicTransaction),
      count: transactions.length,
    });
  } catch (e) {
    // A rejected or unparseable upload must not leave bytes on disk.
    if (storageKey) {
      await removeUserUpload(userId, storageKey).catch(() => {});
    }
    if (e instanceof UploadValidationError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
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
