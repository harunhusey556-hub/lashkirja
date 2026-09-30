/**
 * Payment reminders for overdue sales invoices.
 *
 * A reminder is only ever produced for an invoice that is genuinely overdue
 * and genuinely unpaid, and what was demanded on the day it was sent is stored
 * so the figure stays reconstructible months later.
 */
import { prisma } from "./db";
import { formatDate } from "./format";
import { AppError, NotFoundError, ValidationError } from "./api-errors";
import { centsToEuros } from "./money";
import { buildReminderTotals, daysLate } from "./late-interest";
import { addDaysUtc, openPosition } from "./invoices";
import { helsinkiCalendarDate } from "./validation";
import { buildInvoicePdfData, getInvoice, type PublicInvoice } from "./sales-invoices";
import { renderReminderPdf, type ReminderPdfData } from "./invoice-pdf";

/** Days the customer is given to pay a reminder. */
export const REMINDER_TERM_DAYS = 7;

/** A new reminder for the same invoice waits this long after the previous one. */
export const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * A reminder row is written before its mail goes out and has no recipient
 * until the mail server has accepted it. A row that stays in that state longer
 * than this belongs to a process that died, and is swept away.
 */
export const REMINDER_RESERVATION_STALE_MS = 10 * 60 * 1000;

export interface ReminderPreview {
  invoice: PublicInvoice;
  level: number;
  daysLate: number;
  open: number;
  interest: number;
  fee: number;
  total: number;
  annualRatePercent: number | null;
  dueDate: string;
  recipient: string | null;
  previousReminders: Array<{ level: number; sentAt: string; total: number }>;
}

async function loadSettings(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lateInterestPercent: true, reminderFeeCents: true },
  });
  if (!user) throw new NotFoundError("Käyttäjää ei löytynyt.");
  return user;
}

export async function previewReminder(
  userId: string,
  invoiceId: string,
  now: Date = new Date()
): Promise<ReminderPreview> {
  const invoice = await getInvoice(userId, invoiceId);
  if (invoice.status !== "sent") {
    throw new AppError(
      "Muistutus koskee vain lähetettyä, maksamatonta laskua.",
      "INVOICE_NOT_OPEN",
      409
    );
  }
  if (invoice.open <= 0) {
    throw new AppError("Lasku on jo maksettu.", "INVOICE_SETTLED", 409);
  }

  const late = daysLate(invoice.dueDate, now);
  if (late === 0) {
    throw new AppError(
      "Laskun eräpäivä ei ole vielä mennyt.",
      "INVOICE_NOT_OVERDUE",
      409
    );
  }

  const settings = await loadSettings(userId);
  const reminders = await prisma.invoiceReminder.findMany({
    // A row without a recipient is a send in flight, not a reminder yet.
    where: { invoiceId, sentTo: { not: null } },
    orderBy: { sentAt: "asc" },
  });

  const totals = buildReminderTotals({
    openCents: Math.round(invoice.open * 100),
    dueDate: invoice.dueDate,
    on: now,
    annualRatePercent: settings.lateInterestPercent,
    feeCents: settings.reminderFeeCents,
  });

  return {
    invoice,
    level: reminders.length + 1,
    daysLate: totals.days,
    open: centsToEuros(totals.openCents),
    interest: centsToEuros(totals.interestCents),
    fee: centsToEuros(totals.feeCents),
    total: centsToEuros(totals.totalCents),
    annualRatePercent: settings.lateInterestPercent,
    dueDate: addDaysUtc(now, REMINDER_TERM_DAYS).toISOString().slice(0, 10),
    recipient: invoice.customer.email,
    previousReminders: reminders.map((reminder) => ({
      level: reminder.level,
      sentAt: reminder.sentAt.toISOString(),
      total: centsToEuros(reminder.totalCents),
    })),
  };
}

export async function buildReminderPdfData(
  userId: string,
  invoiceId: string,
  now: Date = new Date(),
  /** The preview the caller already holds, so the figures and level stay the ones it reserved. */
  given?: ReminderPreview
): Promise<{ pdf: ReminderPdfData; preview: ReminderPreview }> {
  const preview = given ?? (await previewReminder(userId, invoiceId, now));
  const invoiceData = await buildInvoicePdfData(userId, invoiceId);

  return {
    preview,
    pdf: {
      level: preview.level,
      invoiceNumber: invoiceData.number,
      reference: invoiceData.reference,
      originalIssueDate: invoiceData.issueDate,
      originalDueDate: invoiceData.dueDate,
      dueDate: preview.dueDate,
      daysLate: preview.daysLate,
      openCents: Math.round(preview.open * 100),
      interestCents: Math.round(preview.interest * 100),
      feeCents: Math.round(preview.fee * 100),
      totalCents: Math.round(preview.total * 100),
      annualRatePercent: preview.annualRatePercent,
      seller: invoiceData.seller,
      customer: invoiceData.customer,
    },
  };
}

export async function renderReminder(
  userId: string,
  invoiceId: string,
  now: Date = new Date(),
  given?: ReminderPreview
): Promise<{ buffer: Buffer; preview: ReminderPreview }> {
  const { pdf, preview } = await buildReminderPdfData(userId, invoiceId, now, given);
  return { buffer: await renderReminderPdf(pdf), preview };
}

function cooldownMessage(sentAt: Date): string {
  const again = new Date(sentAt.getTime() + REMINDER_COOLDOWN_MS);
  return (
    `Muistutus lähetettiin jo ${formatDate(helsinkiCalendarDate(sentAt))}. ` +
    `Seuraava voidaan lähettää vasta ${formatDate(helsinkiCalendarDate(again))}.`
  );
}

/**
 * Claims the next reminder slot of an invoice before anything is mailed.
 *
 * The row is written first, in one transaction, and its level is counted in
 * that same transaction. SQLite lets one writer through at a time, so two calls
 * that arrive together are numbered one after the other and the second one
 * finds the first one's row and is refused, instead of both mailing. The row
 * has no recipient until `confirmReminder`; `releaseReminder` takes it back
 * when the mail did not go out.
 */
export async function reserveReminder(
  userId: string,
  invoiceId: string,
  preview: ReminderPreview,
  now: Date = new Date()
) {
  return prisma.$transaction(async (tx) => {
    // The first statement of the transaction is a write, so the write lock is
    // taken here and every read below sees what the previous caller committed.
    await tx.invoiceReminder.deleteMany({
      where: {
        invoiceId,
        invoice: { userId },
        sentTo: null,
        sentAt: { lt: new Date(now.getTime() - REMINDER_RESERVATION_STALE_MS) },
      },
    });

    const invoice = await tx.salesInvoice.findFirst({
      where: { id: invoiceId, userId },
      select: { id: true },
    });
    if (!invoice) throw new NotFoundError("Laskua ei löytynyt.");

    const existing = await tx.invoiceReminder.findMany({
      where: { invoiceId },
      select: { sentTo: true, sentAt: true },
    });
    if (existing.some((row) => row.sentTo === null)) {
      throw new AppError(
        "Muistutusta lähetetään juuri nyt. Odota hetki.",
        "REMINDER_IN_PROGRESS",
        409
      );
    }
    const latest = existing.reduce<Date | null>(
      (best, row) => (best === null || row.sentAt > best ? row.sentAt : best),
      null
    );
    if (latest && now.getTime() - latest.getTime() < REMINDER_COOLDOWN_MS) {
      throw new AppError(cooldownMessage(latest), "REMINDER_TOO_SOON", 409);
    }

    return tx.invoiceReminder.create({
      data: {
        invoiceId,
        level: existing.length + 1,
        sentTo: null,
        sentAt: now,
        dueDate: new Date(`${preview.dueDate}T00:00:00.000Z`),
        openCents: Math.round(preview.open * 100),
        interestCents: Math.round(preview.interest * 100),
        feeCents: Math.round(preview.fee * 100),
        totalCents: Math.round(preview.total * 100),
        annualRatePercent: preview.annualRatePercent,
        daysLate: preview.daysLate,
      },
    });
  });
}

/** The mail server accepted the reminder: it now counts as sent to `sentTo`. */
export async function confirmReminder(reminderId: string, sentTo: string, now: Date = new Date()) {
  return prisma.invoiceReminder.update({
    where: { id: reminderId },
    data: { sentTo, sentAt: now },
  });
}

/** The mail did not go out: give the slot back so a retry is possible. */
export async function releaseReminder(reminderId: string): Promise<void> {
  await prisma.invoiceReminder.deleteMany({ where: { id: reminderId, sentTo: null } });
}

export interface OverdueSummary {
  invoiceId: string;
  number: number;
  customerName: string;
  customerEmail: string | null;
  dueDate: string;
  daysLate: number;
  open: number;
  reminderCount: number;
  lastReminderAt: string | null;
}

/** Everything that is overdue, worst first: the reminder work list. */
export async function listOverdueInvoices(
  userId: string,
  now: Date = new Date()
): Promise<OverdueSummary[]> {
  const invoices = await prisma.salesInvoice.findMany({
    where: { userId, status: { in: ["sent", "paid"] } },
    include: {
      customer: { select: { name: true, email: true } },
      payments: { select: { amountCents: true } },
      reminders: { where: { sentTo: { not: null } }, orderBy: { sentAt: "desc" }, take: 1 },
      _count: { select: { reminders: { where: { sentTo: { not: null } } } } },
    },
    orderBy: { dueDate: "asc" },
  });

  return invoices
    .map((invoice) => {
      const paid = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
      const position = openPosition({
        status: invoice.status,
        grossCents: invoice.grossCents,
        paidCents: paid,
        closedReason: invoice.closedReason,
      });
      return {
        invoiceId: invoice.id,
        number: invoice.number,
        customerName: invoice.customer.name,
        customerEmail: invoice.customer.email,
        dueDate: invoice.dueDate.toISOString().slice(0, 10),
        daysLate: daysLate(invoice.dueDate, now),
        open: centsToEuros(position.collectible ? position.openCents : 0),
        reminderCount: invoice._count.reminders,
        lastReminderAt: invoice.reminders[0]?.sentAt.toISOString() ?? null,
      };
    })
    .filter((invoice) => invoice.daysLate > 0 && invoice.open > 0)
    .sort((a, b) => b.daysLate - a.daysLate);
}

export interface ReminderSettingsInput {
  lateInterestPercent?: number | null;
  reminderFee?: number;
}

/** Validated reminder columns. Does not write; the caller persists them. */
export function reminderSettingsData(input: ReminderSettingsInput): {
  lateInterestPercent?: number | null;
  reminderFeeCents?: number;
} {
  const data: { lateInterestPercent?: number | null; reminderFeeCents?: number } = {};
  if (input.lateInterestPercent !== undefined) {
    if (input.lateInterestPercent !== null) {
      if (!Number.isFinite(input.lateInterestPercent) || input.lateInterestPercent < 0) {
        throw new ValidationError("Viivästyskorko ei voi olla negatiivinen.");
      }
      if (input.lateInterestPercent > 100) {
        throw new ValidationError("Viivästyskorko on epärealistisen suuri.");
      }
    }
    data.lateInterestPercent = input.lateInterestPercent;
  }
  if (input.reminderFee !== undefined) {
    const cents = Math.round(input.reminderFee * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      throw new ValidationError("Muistutusmaksu ei voi olla negatiivinen.");
    }
    data.reminderFeeCents = cents;
  }
  return data;
}

export async function updateReminderSettings(userId: string, input: ReminderSettingsInput) {
  const data = reminderSettingsData(input);
  if (Object.keys(data).length === 0) return loadSettings(userId);

  const user = await prisma.user.update({
    where: { id: userId },
    data,
    select: { lateInterestPercent: true, reminderFeeCents: true },
  });
  return user;
}
