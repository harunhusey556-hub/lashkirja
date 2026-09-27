/**
 * What is still open in a month before the books are locked.
 * The lock itself stays allowed: this is the list the user sees first.
 */
import { prisma } from "./db";
import { centsToEuros } from "./money";
import { formatEur } from "./format";
import { monthBoundsUtc } from "./validation";

export interface PeriodPrecheckItem {
  id: string;
  title: string;
  detail: string;
  href: string;
}

export interface PeriodPrecheck {
  month: string;
  missingDocuments: PeriodPrecheckItem[];
  unmatchedTransactions: PeriodPrecheckItem[];
  draftInvoices: PeriodPrecheckItem[];
}

const TAKE = 50;

function money(cents: number): string {
  return formatEur(centsToEuros(cents));
}

export async function listPeriodPrecheck(userId: string, month: string): Promise<PeriodPrecheck> {
  const { start, end } = monthBoundsUtc(month);
  const [unmatched, suggested, pending, drafts] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        statement: { userId, periodMonth: month },
        type: { in: ["tulo", "meno"] },
        matchStatus: "unmatched",
        receiptId: null,
      },
      orderBy: { date: "asc" },
      take: TAKE,
      select: {
        id: true,
        counterparty: true,
        message: true,
        amountCents: true,
        statementId: true,
      },
    }),
    prisma.transaction.findMany({
      where: {
        statement: { userId, periodMonth: month },
        type: { in: ["tulo", "meno"] },
        matchStatus: "suggested",
      },
      orderBy: { date: "asc" },
      take: TAKE,
      select: {
        id: true,
        counterparty: true,
        message: true,
        amountCents: true,
        statementId: true,
      },
    }),
    prisma.receipt.findMany({
      where: {
        userId,
        reviewStatus: "pending",
        date: { gte: start, lt: end },
      },
      orderBy: { date: "asc" },
      take: TAKE,
      select: { id: true, vendor: true, fileName: true, totalAmountCents: true },
    }),
    prisma.salesInvoice.findMany({
      where: {
        userId,
        status: "draft",
        documentKind: "invoice",
        issueDate: { gte: start, lt: end },
      },
      orderBy: { number: "asc" },
      take: TAKE,
      select: {
        id: true,
        number: true,
        grossCents: true,
        customer: { select: { name: true } },
      },
    }),
  ]);

  return {
    month,
    missingDocuments: [
      ...unmatched.map((tx) => ({
        id: tx.id,
        title: tx.counterparty || tx.message || "Pankkitapahtuma",
        detail: `${money(tx.amountCents)} · ei tositetta`,
        href: `/tiliotteet/${tx.statementId}`,
      })),
      ...pending.map((receipt) => ({
        id: receipt.id,
        title: receipt.vendor || receipt.fileName || "Kuitti",
        detail:
          receipt.totalAmountCents == null
            ? "Odottaa tarkistusta"
            : `${money(receipt.totalAmountCents)} · odottaa tarkistusta`,
        href: `/kuitit/${receipt.id}`,
      })),
    ],
    unmatchedTransactions: suggested.map((tx) => ({
      id: tx.id,
      title: tx.counterparty || tx.message || "Pankkitapahtuma",
      detail: `${money(tx.amountCents)} · ehdotettu täsmäytys`,
      href: `/tiliotteet/${tx.statementId}`,
    })),
    draftInvoices: drafts.map((invoice) => ({
      id: invoice.id,
      title: invoice.customer.name,
      detail: `Luonnos ${invoice.number} · ${money(invoice.grossCents)}`,
      href: `/laskut/${invoice.id}`,
    })),
  };
}
