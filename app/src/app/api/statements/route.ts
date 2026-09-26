import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import {
  parseCamtXML,
  parseXLSX,
  parseCSV,
  parsePDFStatement,
} from "@/lib/parsers";
import * as fs from "fs";
import * as path from "path";
import { v4 as uuid } from "uuid";
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
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json(
        { error: "Tiedosto puuttuu" },
        { status: 400 }
      );
    }

    const uploadsDir = path.join(process.cwd(), "data", "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const ext = path.extname(file.name).toLowerCase();
    const fileName = `${uuid()}${ext}`;
    const filePath = path.join(uploadsDir, fileName);

    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    let fileType = "unknown";
    let parsedTransactions;

    if (ext === ".xml") {
      fileType = "camt-xml";
      parsedTransactions = await parseCamtXML(filePath);
    } else if (ext === ".xlsx" || ext === ".xls") {
      fileType = "xlsx";
      parsedTransactions = await parseXLSX(filePath);
    } else if (ext === ".csv") {
      fileType = "csv";
      parsedTransactions = await parseCSV(filePath);
    } else if (ext === ".pdf") {
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
          userId: session.userId!,
          fileName: file.name,
          fileType,
          filePath: fileName,
          periodMonth,
          periodSource: "auto",
        },
      });
      await db.transaction.createMany({
        data: parsedTransactions.map((tx) => ({
          statementId: created.id,
          userId: session.userId!,
          date: tx.date ? new Date(tx.date) : null,
          counterparty: tx.counterparty,
          amountCents: eurosToCents(tx.amount),
          reference: tx.reference,
          message: tx.message,
          source: "file",
          type: inferTransactionType(tx.amount, {
            counterparty: tx.counterparty,
            message: tx.message,
          }),
        })),
      });
      return created;
    });

    await runMatching(session.userId!).catch((e) =>
      console.error("Matching after statement upload failed:", e)
    );

    // Auto-generate receipts for new income rows
    await autoGenerateIncomeReceipts(session.userId!, statement.id).catch((e) => 
      console.error("Income auto-generation failed:", e)
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
    console.error("Statement upload error:", e);
    return NextResponse.json(
      { error: "Tiedoston käsittely epäonnistui" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const month = new URL(req.url).searchParams.get("month");
  const statements = await listStatementsForUser(session.userId, month);
  return NextResponse.json({ statements });
}
