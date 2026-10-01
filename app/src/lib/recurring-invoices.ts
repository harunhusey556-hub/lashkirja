/**
 * Recurring invoices: a standing order that produces real invoices.
 *
 * Generation is idempotent by construction. Each occurrence is one row in
 * RecurringInvoiceRun keyed by (schedule, issueDate) with a unique index, so a
 * second run on the same day - a retried cron, two tabs, whatever - loses the
 * race at the database rather than invoicing the customer twice.
 */
import { prisma } from "./db";
import { AppError, NotFoundError, ValidationError, errorText } from "./api-errors";
import { centsToEuros } from "./money";
import { isoDateToUtc } from "./validation";
import { requireActiveCustomer } from "./customers";
import { PeriodLockedError } from "./period-lock";
import { adjustVatRateForDate } from "./invoices";
import {
  applyVatRules,
  createInvoice,
  toLineInputs,
  type InvoiceLinePayload,
  type PublicInvoice,
} from "./sales-invoices";
import {
  dueRuns,
  firstRun,
  nextRunAfter,
  MAX_CATCH_UP_RUNS,
  RECURRENCE_INTERVALS,
  type RecurrenceInterval,
  type Schedule,
} from "./recurrence";

export interface RecurringInvoiceInput {
  customerId: string;
  name?: string | null;
  interval: RecurrenceInterval;
  anchorDay: number;
  startDate: string;
  endDate?: string | null;
  paymentTermDays?: number;
  notes?: string | null;
  autoSend?: boolean;
  active?: boolean;
  lines: InvoiceLinePayload[];
}

export interface PublicRecurringInvoice {
  id: string;
  name: string | null;
  interval: RecurrenceInterval;
  anchorDay: number;
  startDate: string;
  endDate: string | null;
  nextRunAt: string | null;
  paymentTermDays: number;
  notes: string | null;
  autoSend: boolean;
  active: boolean;
  customer: { id: string; name: string; email: string | null };
  lines: Array<{
    id: string;
    description: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    vatRate: number;
  }>;
  total: number;
  generatedCount: number;
  lastRun: { issueDate: string; status: string; invoiceId: string | null } | null;
}

const recurringInclude = {
  customer: { select: { id: true, name: true, email: true } },
  lines: { orderBy: { sortOrder: "asc" as const } },
  runs: { orderBy: { issueDate: "desc" as const }, take: 1 },
  _count: { select: { runs: true } },
};

type RecurringRow = {
  id: string;
  name: string | null;
  interval: string;
  anchorDay: number;
  startDate: Date;
  endDate: Date | null;
  nextRunAt: Date | null;
  paymentTermDays: number;
  notes: string | null;
  autoSend: boolean;
  active: boolean;
  customer: { id: string; name: string; email: string | null };
  lines: Array<{
    id: string;
    description: string;
    quantityMilli: number;
    unit: string;
    unitPriceCents: number;
    vatRatePermille: number;
  }>;
  runs: Array<{ issueDate: Date; status: string; invoiceId: string | null }>;
  _count: { runs: number };
};

function iso(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

export function toPublicRecurringInvoice(row: RecurringRow): PublicRecurringInvoice {
  const total = row.lines.reduce(
    (sum, line) => sum + Math.round((line.quantityMilli * line.unitPriceCents) / 1000),
    0
  );
  return {
    id: row.id,
    name: row.name,
    interval: row.interval as RecurrenceInterval,
    anchorDay: row.anchorDay,
    startDate: iso(row.startDate)!,
    endDate: iso(row.endDate),
    nextRunAt: iso(row.nextRunAt),
    paymentTermDays: row.paymentTermDays,
    notes: row.notes,
    autoSend: row.autoSend,
    active: row.active,
    customer: row.customer,
    lines: row.lines.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantityMilli / 1000,
      unit: line.unit,
      unitPrice: centsToEuros(line.unitPriceCents),
      vatRate: line.vatRatePermille / 10,
    })),
    total: centsToEuros(total),
    generatedCount: row._count.runs,
    lastRun: row.runs[0]
      ? {
          issueDate: iso(row.runs[0].issueDate)!,
          status: row.runs[0].status,
          invoiceId: row.runs[0].invoiceId,
        }
      : null,
  };
}

function validateSchedule(input: {
  interval: RecurrenceInterval;
  anchorDay: number;
  startDate: string;
  endDate?: string | null;
}): Schedule {
  if (!RECURRENCE_INTERVALS.includes(input.interval)) {
    throw new ValidationError("Tuntematon toistoväli.");
  }
  if (!Number.isInteger(input.anchorDay) || input.anchorDay < 1 || input.anchorDay > 31) {
    throw new ValidationError("Laskutuspäivä on 1-31.");
  }
  if (input.endDate && input.endDate < input.startDate) {
    throw new ValidationError("Päättymispäivä ei voi olla ennen alkupäivää.");
  }
  return {
    interval: input.interval,
    anchorDay: input.anchorDay,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
  };
}

export async function createRecurringInvoice(
  userId: string,
  input: RecurringInvoiceInput
): Promise<PublicRecurringInvoice> {
  const customer = await requireActiveCustomer(userId, input.customerId);
  const schedule = validateSchedule(input);
  const start = firstRun(schedule);
  // The template follows the same VAT rules as an invoice dated on its first
  // run: 0 % for a seller who is not VAT registered, only rates valid that day
  // otherwise. Each run applies them again, because the profile may change.
  const lines = await applyVatRules(userId, toLineInputs(input.lines), start);

  // A schedule whose first run is already past its end never runs at all.
  const nextRunAt = schedule.endDate && start > schedule.endDate ? null : start;

  const created = await prisma.recurringInvoice.create({
    data: {
      userId,
      customerId: customer.id,
      name: input.name?.trim() || null,
      interval: schedule.interval,
      anchorDay: schedule.anchorDay,
      startDate: isoDateToUtc(schedule.startDate),
      endDate: schedule.endDate ? isoDateToUtc(schedule.endDate) : null,
      nextRunAt: nextRunAt ? isoDateToUtc(nextRunAt) : null,
      paymentTermDays: input.paymentTermDays ?? customer.defaultPaymentTermDays,
      notes: input.notes?.trim() || null,
      autoSend: input.autoSend ?? false,
      active: input.active ?? true,
      lines: {
        create: lines.map((line, index) => ({
          sortOrder: index,
          description: line.description,
          unit: line.unit,
          quantityMilli: line.quantityMilli,
          unitPriceCents: line.unitPriceCents,
          vatRatePermille: line.vatRatePermille,
        })),
      },
    },
    include: recurringInclude,
  });

  return toPublicRecurringInvoice(created);
}

export async function getRecurringInvoice(
  userId: string,
  id: string
): Promise<PublicRecurringInvoice> {
  const row = await prisma.recurringInvoice.findFirst({
    where: { id, userId },
    include: recurringInclude,
  });
  if (!row) throw new NotFoundError("Toistuvaa laskua ei löytynyt.");
  return toPublicRecurringInvoice(row);
}

export async function listRecurringInvoices(
  userId: string,
  options: { includeInactive?: boolean } = {}
): Promise<PublicRecurringInvoice[]> {
  const rows = await prisma.recurringInvoice.findMany({
    where: { userId, ...(options.includeInactive ? {} : { active: true }) },
    include: recurringInclude,
    orderBy: [{ active: "desc" }, { nextRunAt: "asc" }],
  });
  return rows.map(toPublicRecurringInvoice);
}

export async function updateRecurringInvoice(
  userId: string,
  id: string,
  input: Partial<RecurringInvoiceInput>
): Promise<PublicRecurringInvoice> {
  const existing = await prisma.recurringInvoice.findFirst({ where: { id, userId } });
  if (!existing) throw new NotFoundError("Toistuvaa laskua ei löytynyt.");

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name?.trim() || null;
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
  if (input.autoSend !== undefined) data.autoSend = input.autoSend;
  if (input.active !== undefined) data.active = input.active;
  if (input.paymentTermDays !== undefined) {
    if (
      !Number.isInteger(input.paymentTermDays) ||
      input.paymentTermDays < 0 ||
      input.paymentTermDays > 365
    ) {
      throw new ValidationError("Maksuaika on 0-365 päivää.");
    }
    data.paymentTermDays = input.paymentTermDays;
  }
  if (input.customerId) {
    const customer = await requireActiveCustomer(userId, input.customerId);
    data.customerId = customer.id;
  }

  const scheduleChanged =
    input.interval !== undefined ||
    input.anchorDay !== undefined ||
    input.startDate !== undefined ||
    input.endDate !== undefined;

  if (scheduleChanged) {
    const schedule = validateSchedule({
      interval: (input.interval ?? existing.interval) as RecurrenceInterval,
      anchorDay: input.anchorDay ?? existing.anchorDay,
      startDate: input.startDate ?? iso(existing.startDate)!,
      endDate:
        input.endDate !== undefined ? input.endDate : iso(existing.endDate),
    });
    data.interval = schedule.interval;
    data.anchorDay = schedule.anchorDay;
    data.startDate = isoDateToUtc(schedule.startDate);
    data.endDate = schedule.endDate ? isoDateToUtc(schedule.endDate) : null;

    // Occurrences already generated are history. The next one is a full
    // interval after the last generated occurrence, on the new anchor day -
    // moving the billing day must not squeeze a second invoice into a period
    // that has already been billed.
    const lastRun = await prisma.recurringInvoiceRun.findFirst({
      where: { recurringInvoiceId: id },
      orderBy: { issueDate: "desc" },
      select: { issueDate: true },
    });
    const next = lastRun
      ? nextRunAfter(schedule, iso(lastRun.issueDate)!)
      : firstRun(schedule);
    data.nextRunAt =
      schedule.endDate && next > schedule.endDate ? null : isoDateToUtc(next);
  }

  if (input.lines) {
    // Same date the form checks: the first invoice of the schedule as it will
    // be saved (an old 14 % template stays editable, its runs follow the change).
    const ruleDate = firstRun(
      validateSchedule({
        interval: (input.interval ?? existing.interval) as RecurrenceInterval,
        anchorDay: input.anchorDay ?? existing.anchorDay,
        startDate: input.startDate ?? iso(existing.startDate)!,
        endDate: input.endDate !== undefined ? input.endDate : iso(existing.endDate),
      })
    );
    const lines = await applyVatRules(userId, toLineInputs(input.lines), ruleDate);
    await prisma.$transaction([
      prisma.recurringInvoiceLine.deleteMany({ where: { recurringInvoiceId: id } }),
      prisma.recurringInvoiceLine.createMany({
        data: lines.map((line, index) => ({
          recurringInvoiceId: id,
          sortOrder: index,
          description: line.description,
          unit: line.unit,
          quantityMilli: line.quantityMilli,
          unitPriceCents: line.unitPriceCents,
          vatRatePermille: line.vatRatePermille,
        })),
      }),
      prisma.recurringInvoice.update({ where: { id }, data }),
    ]);
  } else {
    await prisma.recurringInvoice.update({ where: { id }, data });
  }

  return getRecurringInvoice(userId, id);
}

export async function deleteRecurringInvoice(userId: string, id: string): Promise<void> {
  const existing = await prisma.recurringInvoice.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError("Toistuvaa laskua ei löytynyt.");
  // Generated invoices survive: the run rows lose their schedule, not the
  // customer's invoice.
  await prisma.recurringInvoice.delete({ where: { id } });
}

export interface GeneratedInvoice {
  recurringInvoiceId: string;
  issueDate: string;
  invoice: PublicInvoice;
  sent: boolean;
  sendError: string | null;
}

export interface RunResult {
  generated: GeneratedInvoice[];
  skipped: Array<{
    recurringInvoiceId: string;
    issueDate: string;
    reason: "period_locked" | "already_generated" | "failed";
    detail?: string;
  }>;
  truncated: string[];
}

export interface RunOptions {
  now?: Date;
  /** Restrict to one schedule, for a "run this now" button. */
  recurringInvoiceId?: string;
  /** Injected so the run can be tested without a mail server. */
  send?: (invoiceId: string) => Promise<void>;
}

/**
 * Generates every invoice that is owed up to `now`.
 *
 * Sending is best-effort and never loses an invoice: the invoice is created
 * and recorded first, and a failed send is reported against that run instead
 * of rolling anything back.
 */
export async function runRecurringInvoices(
  userId: string,
  options: RunOptions = {}
): Promise<RunResult> {
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  const schedules = await prisma.recurringInvoice.findMany({
    where: {
      userId,
      active: true,
      nextRunAt: { not: null, lte: isoDateToUtc(today) },
      ...(options.recurringInvoiceId ? { id: options.recurringInvoiceId } : {}),
    },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });

  const generated: GeneratedInvoice[] = [];
  const skipped: RunResult["skipped"] = [];
  const truncated: string[] = [];

  for (const schedule of schedules) {
    const definition: Schedule = {
      interval: schedule.interval as RecurrenceInterval,
      anchorDay: schedule.anchorDay,
      startDate: iso(schedule.startDate)!,
      endDate: iso(schedule.endDate),
    };
    const plan = dueRuns(definition, iso(schedule.nextRunAt)!, today, MAX_CATCH_UP_RUNS);
    if (plan.truncated) truncated.push(schedule.id);

    for (const issueDate of plan.dates) {
      // The unique (schedule, issueDate) index is the real guard; claiming the
      // row first means a concurrent run cannot also create the invoice.
      let claimed: { id: string } | null = null;
      try {
        claimed = await prisma.recurringInvoiceRun.create({
          data: { recurringInvoiceId: schedule.id, issueDate: isoDateToUtc(issueDate) },
          select: { id: true },
        });
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") {
          skipped.push({
            recurringInvoiceId: schedule.id,
            issueDate,
            reason: "already_generated",
          });
          continue;
        }
        throw error;
      }

      try {
        const invoice = await createInvoice(userId, {
          customerId: schedule.customerId,
          issueDate,
          paymentTermDays: schedule.paymentTermDays,
          notes: schedule.notes,
          lines: schedule.lines.map((line) => ({
            description: line.description,
            quantity: line.quantityMilli / 1000,
            unit: line.unit,
            unitPrice: centsToEuros(line.unitPriceCents),
            // A template saved at 14 % keeps billing the same goods at 13,5 %
            // from 1.1.2026; createInvoice forces 0 % for an unregistered seller.
            vatRate: adjustVatRateForDate(line.vatRatePermille, issueDate) / 10,
          })),
        });

        let sent = false;
        let sendError: string | null = null;
        if (schedule.autoSend && options.send) {
          try {
            await options.send(invoice.id);
            sent = true;
          } catch (error) {
            // The invoice exists; only the delivery failed.
            sendError = errorText(error, "Lähetys epäonnistui");
          }
        }

        await prisma.recurringInvoiceRun.update({
          where: { id: claimed.id },
          data: { invoiceId: invoice.id, status: "created", note: sendError },
        });

        generated.push({
          recurringInvoiceId: schedule.id,
          issueDate,
          invoice,
          sent,
          sendError,
        });
      } catch (error) {
        const locked = error instanceof PeriodLockedError;
        await prisma.recurringInvoiceRun.update({
          where: { id: claimed.id },
          data: {
            status: locked ? "skipped_locked" : "failed",
            note: errorText(error),
          },
        });
        skipped.push({
          recurringInvoiceId: schedule.id,
          issueDate,
          reason: locked ? "period_locked" : "failed",
          detail: errorText(error),
        });
      }
    }

    await prisma.recurringInvoice.update({
      where: { id: schedule.id },
      data: { nextRunAt: plan.nextRun ? isoDateToUtc(plan.nextRun) : null },
    });
  }

  return { generated, skipped, truncated };
}

/** Schedules whose next run has arrived, for a "due now" badge. */
export async function countDueRecurringInvoices(
  userId: string,
  now: Date = new Date()
): Promise<number> {
  return prisma.recurringInvoice.count({
    where: {
      userId,
      active: true,
      nextRunAt: { not: null, lte: isoDateToUtc(now.toISOString().slice(0, 10)) },
    },
  });
}

/** Guard for the manual "run now" button on a single schedule. */
export async function requireOwnedRecurring(userId: string, id: string): Promise<void> {
  const existing = await prisma.recurringInvoice.findFirst({
    where: { id, userId },
    select: { id: true, active: true },
  });
  if (!existing) throw new NotFoundError("Toistuvaa laskua ei löytynyt.");
  if (!existing.active) {
    throw new AppError("Toistuva lasku on pysäytetty.", "RECURRING_INACTIVE", 409);
  }
}
