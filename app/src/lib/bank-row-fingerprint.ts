/**
 * Recognising a bank row that is already stored, whichever way it arrived.
 *
 * Rows come from tiliote files (no stable id) and from the bank feed (a
 * `bankRef` of its own). Two files that overlap, or a file and the feed, carry
 * the same movements under different ids, so the only thing they share is what
 * the row says: the booking date, the amount in cents and who it was with.
 * That is the key here.
 *
 * Two genuine identical rows on one day (two coffees of 4,50) must both
 * survive, so a key is matched as a multiset: an incoming row is a duplicate
 * only while an unclaimed stored copy of it is left.
 */
import type { Prisma } from "@/generated/prisma/client";

export interface RowIdentity {
  /** "YYYY-MM-DD", or null for an undated row. */
  date: string | null;
  amountCents: number;
  counterparty?: string | null;
  message?: string | null;
}

/** Lower case, letters and digits only, single spaces. "TOINEN  Asiakas Oy." -> "toinen asiakas oy". */
export function normaliseRowText(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("fi")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function dayKey(row: RowIdentity): string {
  return `${row.date ? row.date.slice(0, 10) : "-"}|${row.amountCents}`;
}

/** One string per movement: date, cents and the normalised counterparty. */
export function bankRowKey(row: RowIdentity): string {
  return `${dayKey(row)}|${normaliseRowText(row.counterparty)}`;
}

/**
 * Splits incoming rows into new ones and ones already stored. A stored row
 * with no counterparty (the feed does not always name one) stands for any name
 * on the same day and amount; otherwise the names must agree.
 */
export function splitNewRows<T extends RowIdentity>(
  incoming: T[],
  existing: RowIdentity[]
): { fresh: T[]; duplicates: T[] } {
  const stored = new Map<string, Array<{ text: string; used: boolean }>>();
  for (const row of existing) {
    const key = dayKey(row);
    const bucket = stored.get(key) ?? [];
    bucket.push({ text: normaliseRowText(row.counterparty), used: false });
    stored.set(key, bucket);
  }

  const fresh: T[] = [];
  const duplicates: T[] = [];
  for (const row of incoming) {
    const bucket = stored.get(dayKey(row));
    const text = normaliseRowText(row.counterparty);
    const match =
      bucket?.find((copy) => !copy.used && copy.text === text) ??
      bucket?.find((copy) => !copy.used && (copy.text === "" || text === ""));
    if (match) {
      match.used = true;
      duplicates.push(row);
    } else {
      fresh.push(row);
    }
  }
  return { fresh, duplicates };
}

/** One sentence for the owner about the rows that were left out. */
export function skippedRowsNotice(skipped: number): string | null {
  if (skipped <= 0) return null;
  return skipped === 1
    ? "1 tapahtuma oli jo tuotu aiemmin, joten se ohitettiin."
    : `${skipped} tapahtumaa oli jo tuotu aiemmin, joten ne ohitettiin.`;
}

/**
 * The rows already stored for this user and bank account over the days the
 * incoming rows cover, from any statement and any source (file or bank feed).
 */
export async function loadStoredRowIdentities(
  db: Prisma.TransactionClient,
  userId: string,
  bankAccountId: string | null,
  incoming: RowIdentity[]
): Promise<RowIdentity[]> {
  const dates = incoming.flatMap((row) => (row.date ? [row.date.slice(0, 10)] : []));
  const hasUndated = incoming.some((row) => !row.date);
  const ranges: Prisma.TransactionWhereInput[] = [];
  if (dates.length > 0) {
    const first = dates.reduce((a, b) => (a < b ? a : b));
    const last = dates.reduce((a, b) => (a > b ? a : b));
    const end = new Date(`${last}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    ranges.push({ date: { gte: new Date(`${first}T00:00:00.000Z`), lt: end } });
  }
  if (hasUndated) ranges.push({ date: null });
  if (ranges.length === 0) return [];

  const rows = await db.transaction.findMany({
    where: { statement: { userId, bankAccountId }, OR: ranges },
    select: { date: true, amountCents: true, counterparty: true, message: true },
  });
  return rows.map((row) => ({
    date: row.date ? row.date.toISOString().slice(0, 10) : null,
    amountCents: row.amountCents,
    counterparty: row.counterparty,
    message: row.message,
  }));
}
