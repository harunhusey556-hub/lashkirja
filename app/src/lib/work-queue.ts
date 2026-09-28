import { prisma } from "./db";
import { detailHref } from "./routes";

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
    | "ambiguous_match";
  title: string;
  detail: string;
  href: string | null;
}

const TAKE = 40;

export async function listWorkQueue(userId: string): Promise<WorkQueueItem[]> {
  const [pending, unmatched, linked, failedJobs, linkErrors, suggested] = await Promise.all([
    prisma.receipt.findMany({
      where: { userId, reviewStatus: "pending" },
      orderBy: { createdAt: "desc" },
      take: TAKE,
      select: { id: true, vendor: true, fileName: true },
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
      select: { id: true, title: true, error: true },
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
      title: receipt.vendor || receipt.fileName || "Kuitti",
      detail: "Kuitti odottaa tarkistusta.",
      href: detailHref("receipt", receipt.id),
    });
  }

  for (const tx of unmatched) {
    items.push({
      id: `missing_document:${tx.id}`,
      kind: "missing_document",
      title: tx.counterparty || tx.message || "Pankkitapahtuma",
      detail: "Tapahtumalla ei ole tositetta.",
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
      title: tx.receipt?.vendor || tx.counterparty || "Täsmäytys",
      detail: "Linkitetyn kuitin summa eroaa pankkitapahtumasta.",
      href: tx.receipt ? detailHref("receipt", tx.receipt.id) : detailHref("statement", tx.statementId),
    });
    if (items.filter((item) => item.kind === "amount_mismatch").length >= TAKE) break;
  }

  for (const job of failedJobs) {
    items.push({
      id: `corrupt_file:${job.id}`,
      kind: "corrupt_file",
      title: job.title,
      detail: job.error || "Tiedoston analysointi epäonnistui.",
      href: "/tyot",
    });
  }

  for (const event of linkErrors) {
    items.push({
      id: `link_error:${event.id}`,
      kind: "link_error",
      title: "Linkitys epäonnistui",
      detail: event.reason,
      href: event.resourceId ? detailHref("receipt", event.resourceId) : null,
    });
  }

  for (const tx of suggested) {
    items.push({
      id: `ambiguous_match:${tx.id}`,
      kind: "ambiguous_match",
      title: tx.counterparty || "Ehdotettu täsmäytys",
      detail:
        tx.matchScore == null
          ? "Useita tai epävarmoja osumia."
          : "Osuma on epävarma.",
      href: detailHref("statement", tx.statementId),
    });
  }

  return items;
}
