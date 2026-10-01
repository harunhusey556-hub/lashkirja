import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { runMatching } from "@/lib/matching";
import { centsToEuros, eurosToCents } from "@/lib/money";
import { inferTransactionType } from "@/lib/statements";
import { withErrorHandler } from "@/lib/api-errors";
import { assertMonthOpen, assertPeriodOpen } from "@/lib/period-lock";
import { removeBankRows } from "@/lib/bank-row-removal";

const patchSchema = z.object({
  transactionId: z.string().min(1),
  type: z.enum(["meno", "tulo", "oma_siirto", "palkka"]).optional(),
  amount: z.number().finite().optional(),
  counterparty: z.string().max(300).nullish(),
  date: z
    .string()
    .refine((s) => !Number.isNaN(new Date(s).getTime()), "Virheellinen päivä")
    .nullish(),
  message: z.string().max(1000).nullish(),
  reference: z.string().max(200).nullish(),
});

const deleteSchema = z.object({
  transactionId: z.string().min(1),
});

async function ownedStatement(id: string, userId: string) {
  return prisma.statement.findFirst({ where: { id, userId } });
}

export const PATCH = withErrorHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Virheellinen pyyntö" },
      { status: 400 }
    );
  }
  const { transactionId, ...fields } = parsed.data;

  const statement = await ownedStatement(id, session.userId!);
  if (!statement) {
    return NextResponse.json(
      { error: "Tiliotetta ei löytynyt" },
      { status: 404 }
    );
  }

  const row = await prisma.transaction.findFirst({
    where: { id: transactionId, statementId: id },
    select: { date: true },
  });
  if (!row) {
    return NextResponse.json(
      { error: "Tapahtumaa ei löytynyt" },
      { status: 404 }
    );
  }
  // A bank row carries its own date besides its statement's month: neither the
  // month it is in nor the one it is moved to may be closed.
  if (statement.periodMonth) await assertMonthOpen(session.userId!, statement.periodMonth);
  await assertPeriodOpen(session.userId!, [row.date, fields.date || null]);

  const data: Record<string, unknown> = {};
  if (fields.type !== undefined) data.type = fields.type;
  if (fields.amount !== undefined) data.amountCents = eurosToCents(fields.amount);
  if (fields.counterparty !== undefined)
    data.counterparty = fields.counterparty || null;
  if (fields.date !== undefined)
    data.date = fields.date ? new Date(fields.date) : null;
  if (fields.message !== undefined) data.message = fields.message || null;
  if (fields.reference !== undefined) data.reference = fields.reference || null;

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "Ei päivitettäviä kenttiä" },
      { status: 400 }
    );
  }

  // When amount sign flips, keep type consistent unless type was also sent
  if (fields.amount !== undefined && fields.type === undefined) {
    data.type = inferTransactionType(fields.amount, {
      counterparty:
        typeof fields.counterparty === "string"
          ? fields.counterparty
          : undefined,
      message: typeof fields.message === "string" ? fields.message : undefined,
    });
  }

  const result = await prisma.transaction.updateMany({
    where: { id: transactionId, statementId: id },
    data,
  });
  if (result.count === 0) {
    return NextResponse.json(
      { error: "Tapahtumaa ei löytynyt" },
      { status: 404 }
    );
  }

  // Amount/date/type edits can invalidate or unlock suggestions
  await runMatching(session.userId!).catch((e) =>
    console.error("Matching after transaction edit failed:", e)
  );

  const tx = await prisma.transaction.findUnique({
    where: { id: transactionId },
  });
  return NextResponse.json({
    ok: true,
    transaction: tx
      ? { ...tx, amount: centsToEuros(tx.amountCents) }
      : null,
  });
});

export const DELETE = withErrorHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Virheellinen pyyntö" },
      { status: 400 }
    );
  }

  const statement = await ownedStatement(id, session.userId!);
  if (!statement) {
    return NextResponse.json(
      { error: "Tiliotetta ei löytynyt" },
      { status: 404 }
    );
  }

  const row = await prisma.transaction.findFirst({
    where: { id: parsed.data.transactionId, statementId: id },
    select: { id: true, date: true },
  });
  if (!row) {
    return NextResponse.json(
      { error: "Tapahtumaa ei löytynyt" },
      { status: 404 }
    );
  }
  if (statement.periodMonth) await assertMonthOpen(session.userId!, statement.periodMonth);
  await assertPeriodOpen(session.userId!, [row.date]);

  // The row's pending sale draft goes with it, and a booked income receipt of a
  // row that paid an invoice is dropped so the sale is not counted twice.
  const { result, removedDrafts, mergedIntoInvoice } = await removeBankRows(
    session.userId!,
    [row.id],
    (db) => db.transaction.deleteMany({ where: { id: row.id, statementId: id } })
  );
  if (result.count === 0) {
    return NextResponse.json(
      { error: "Tapahtumaa ei löytynyt" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true, removedDrafts, mergedIntoInvoice });
});
