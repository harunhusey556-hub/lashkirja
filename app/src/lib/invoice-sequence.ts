/**
 * Per-user invoice numbers.
 *
 * The sequence only moves forward. Deleting a draft does not return its
 * number, a later calendar year does not start again at 1, and a requested
 * starting number cannot rewind past a number already handed out.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { ValidationError } from "./api-errors";

type Db = Prisma.TransactionClient;

export async function allocateInvoiceNumber(db: Db, userId: string): Promise<number> {
  const row = await db.invoiceSequence.findUnique({ where: { userId } });
  if (!row) {
    const latest = await db.salesInvoice.findFirst({
      where: { userId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const number = (latest?.number ?? 0) + 1;
    await db.invoiceSequence.create({ data: { userId, nextNumber: number + 1 } });
    return number;
  }
  const number = row.nextNumber;
  await db.invoiceSequence.update({
    where: { userId },
    data: { nextNumber: number + 1 },
  });
  return number;
}

/** The next number that would be used, without consuming it. */
export async function peekInvoiceNumber(userId: string): Promise<number> {
  const row = await prisma.invoiceSequence.findUnique({ where: { userId } });
  if (row) return row.nextNumber;
  const latest = await prisma.salesInvoice.findFirst({
    where: { userId },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  return (latest?.number ?? 0) + 1;
}

/**
 * Moves the next number forward to `requested` when that is higher than both
 * the stored cursor and one past the highest invoice already stored.
 */
export async function setInvoiceStartingNumber(userId: string, requested: number): Promise<number> {
  if (!Number.isInteger(requested) || requested < 1 || requested > 1_000_000_000) {
    throw new ValidationError("Aloitusnumero on positiivinen kokonaisluku.");
  }
  return prisma.$transaction(async (tx) => {
    const latest = await tx.salesInvoice.findFirst({
      where: { userId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const floor = (latest?.number ?? 0) + 1;
    const row = await tx.invoiceSequence.findUnique({ where: { userId } });
    const next = Math.max(row?.nextNumber ?? floor, requested, floor);
    if (row) {
      if (next !== row.nextNumber) {
        await tx.invoiceSequence.update({ where: { userId }, data: { nextNumber: next } });
      }
    } else {
      await tx.invoiceSequence.create({ data: { userId, nextNumber: next } });
    }
    return next;
  });
}
