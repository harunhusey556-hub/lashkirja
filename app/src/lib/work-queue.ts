import { prisma } from "./db";
import { detailHref } from "./routes";
import { findPaymentReceiptDuplicates } from "./alv-period";
import { formatEur } from "./format";
import { receiptTitle } from "./display-titles";
import { groupFailedJobs } from "./work-queue-group";
import { centsToEuros } from "./money";

export const AMOUNT_MISMATCH_CENTS = 50;
export const AMBIGUOUS_SCORE = 0.8;

export interface WorkQueueItem {
  id: string;
  kind:
    | "pending_review"
    | "missing_document"
    | "amount_mismatch"
    | "corrupt_file"
    | "link_error"
    | "ambiguous_match"
    | "payment_duplicate";
  title: string;
  detail: string;
  href: string | null;
  /** A failed analysis has no screen of its own: its action is a retry of this job (BOOKS-14). */
  retryJobId?: string;
  /** Every failed job a grouped row retries with its one button (F29); retryJobId is the newest. */
  retryJobIds?: string[];
  /** How many identical failures the row stands for. */
  count?: number;
}

const TAKE = 40;

export async function listWorkQueue(userId: string): Promise<WorkQueueItem[]> {
  const [pending, unmatched, linked, failedJobs, linkErrors, suggested] = await Promise.all([
    prisma.receipt.findMany({
      where: { userId, reviewStatus: "pending" },
      orderBy: { createdAt: "desc" },
      take: TAKE,
      select: { id: true, vendor: true, date: true, createdAt: true },
    }),
    prisma.transaction.findMany({
      where: {
        statement: { userId },
        matchStatus: "unmatched",
        receiptId: null,
        type: { in: ["tulo", "meno"] },
      },
      orderBy: { createdAt: "desc" },
      take: TAKE,
      select: {
        id: true,
        counterparty: true,
        message: true,
        statementId: true,
        amountCents: true,
      },
    }),
    prisma.transaction.findMany({
      where: {
        statement: { userId },
        matchStatus: "confirmed",
        receiptId: { not: null },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        amountCents: true,
        counterparty: true,
        statementId: true,
        receipt: { select: { id: true, vendor: true, totalAmountCents: true } },
      },
    }),
    prisma.backgroundJob.findMany({
      where: { userId, kind: "document_analysis", status: "failed" },
      orderBy: { createdAt: "desc" },
      take: TAKE,
      select: { id: true, kind: true, title: true, error: true, createdAt: true },
    }),
    prisma.automationEvent.findMany({
      where: { userId, kind: "link_error" },
      orderBy: { createdAt: "desc" },
      take: TAKE,
      select: { id: true, resourceId: true, reason: true, newValue: true },
    }),
    prisma.transaction.findMany({
      where: {
        statement: { userId },
        matchStatus: "suggested",
        OR: [{ matchScore: null }, { matchScore: { lt: AMBIGUOUS_SCORE } }],
      },
      orderBy: { createdAt: "desc" },
      take: TAKE,
      select: {
        id: true,
        counterparty: true,
        statementId: true,
        matchScore: true,
      },
    }),
  ]);

  const items: WorkQueueItem[] = [];

  for (const receipt of pending) {
    items.push({
      id: `pending_review:${receipt.id}`,
      kind: "pending_review",
      title: receiptTitle(receipt),
      detail: "Kuitti odottaa tarkistusta.",
      href: detailHref("receipt", receipt.id),
    });
  }

  for (const tx of unmatched) {
    items.push({
      id: `missing_document:${tx.id}`,
      kind: "missing_document",
      title: tx.counterparty || tx.message || "Pankkitapahtuma",
      detail: "Tapahtumalla ei ole kuittia.",
      href: detailHref("statement", tx.statementId),
    });
  }

  for (const tx of linked) {
    const receiptAmount = tx.receipt?.totalAmountCents;
    if (receiptAmount == null) continue;
    if (Math.abs(Math.abs(tx.amountCents) - receiptAmount) <= AMOUNT_MISMATCH_CENTS) continue;
    items.push({
      id: `amount_mismatch:${tx.id}`,
      kind: "amount_mismatch",
      title: tx.receipt?.vendor || tx.counterparty || "Pankkitapahtuma",
      detail: "Kohdistetun kuitin summa eroaa pankkitapahtumasta.",
      href: tx.receipt ? detailHref("receipt", tx.receipt.id) : detailHref("statement", tx.statementId),
    });
    if (items.filter((item) => item.kind === "amount_mismatch").length >= TAKE) break;
  }

  // Identical failures are one row with one retry that starts them all again (F29).
  for (const group of groupFailedJobs(failedJobs)) {
    items.push({
      id: `corrupt_file:${group.id}`,
      kind: "corrupt_file",
      title: group.title,
      detail: group.detail,
      // Not "/tyot": that is the page the user is already on (BOOKS-14).
      href: null,
      retryJobId: group.id,
      retryJobIds: group.jobIds,
      count: group.count,
    });
  }

  for (const event of linkErrors) {
    items.push({
      id: `link_error:${event.id}`,
      kind: "link_error",
      title: "Kohdistus epäonnistui",
      detail: event.reason,
      href: event.resourceId ? detailHref("receipt", event.resourceId) : null,
    });
  }

  for (const tx of suggested) {
    items.push({
      id: `ambiguous_match:${tx.id}`,
      kind: "ambiguous_match",
      title: tx.counterparty || "Ehdotettu kohdistus",
      detail:
        tx.matchScore == null
          ? "Useita tai epävarmoja osumia."
          : "Osuma on epävarma.",
      href: detailHref("statement", tx.statementId),
    });
  }

  // Same money twice: a hand-recorded invoice payment and an income receipt
  // from the bank row. Both still count until the user links or separates them.
  const duplicates = await findPaymentReceiptDuplicates(userId);
  for (const pair of duplicates.slice(0, TAKE)) {
    items.push({
      id: `payment_duplicate:${pair.receiptId}:${pair.paymentId}`,
      kind: "payment_duplicate",
      title: pair.receiptVendor || pair.customerName,
      detail: `Tulokuitti ${formatEur(centsToEuros(pair.amountCents))} voi olla laskun ${pair.invoiceNumber} maksu. Tarkista, ettei tuloa lasketa kahdesti.`,
      href: detailHref("invoice", pair.invoiceId),
    });
  }

  return items;
}
