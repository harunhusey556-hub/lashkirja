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
import { getLockedThrough, isDateLocked, PeriodLockedError } from "./period-lock";
import {
  adjustVatRateForDate,
  applySellerVatRules,
  computeInvoiceTotals,
  InvoiceValidationError,
} from "./invoices";
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
  /** Invoices this schedule has made: skipped and failed occurrences are not counted. */
  generatedCount: number;
  lastRun: { issueDate: string; status: string; invoiceId: string | null } | null;
  /** Occurrences that made no invoice (a closed month, a refusal), with the reason. */
  missedRuns: MissedRun[];
  /** Invoices made but not mailed by the automatic send; still drafts. */
  failedSends: FailedSend[];
}

export interface MissedRun {
  issueDate: string;
  reason: "period_locked" | "failed";
  note: string | null;
}

export interface FailedSend {
  issueDate: string;
  invoiceId: string;
  note: string | null;
}

/** Run statuses: the invoice exists for created and created_send_failed. */
const RUN_MADE_INVOICE = ["created", "created_send_failed"];
/** A failed automatic send is retried by the next runs for this long; after that a person decides. */
const SEND_RETRY_WINDOW_MS = 48 * 60 * 60 * 1000;

const recurringInclude = {
  customer: { select: { id: true, name: true, email: true } },
  lines: { orderBy: { sortOrder: "asc" as const } },
  runs: { orderBy: { issueDate: "desc" as const }, take: 1 },
  _count: { select: { runs: { where: { status: { in: RUN_MADE_INVOICE } } } } },
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

type RunIssues = { missedRuns: MissedRun[]; failedSends: FailedSend[] };

export function toPublicRecurringInvoice(
  row: RecurringRow,
  issues: RunIssues = { missedRuns: [], failedSends: [] }
): PublicRecurringInvoice {
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
    missedRuns: issues.missedRuns,
    failedSends: issues.failedSends,
  };
}

/** The occurrences of these schedules that need a person's attention, by schedule. */
async function loadRunIssues(ids: string[]): Promise<Map<string, RunIssues>> {
  const byId = new Map<string, RunIssues>();
  if (ids.length === 0) return byId;
  const rows = await prisma.recurringInvoiceRun.findMany({
    where: {
      recurringInvoiceId: { in: ids },
      status: { in: ["skipped_locked", "failed", "created_send_failed"] },
    },
    orderBy: { issueDate: "asc" },
    include: { invoice: { select: { status: true } } },
  });
  for (const row of rows) {
    const entry = byId.get(row.recurringInvoiceId) ?? { missedRuns: [], failedSends: [] };
    const issueDate = iso(row.issueDate)!;
    if (row.status === "created_send_failed") {
      // Once the invoice is sent or gone by hand there is nothing left to tell.
      if (row.invoiceId && row.invoice?.status === "draft") {
        entry.failedSends.push({ issueDate, invoiceId: row.invoiceId, note: row.note });
      }
    } else {
      entry.missedRuns.push({
        issueDate,
        reason: row.status === "skipped_locked" ? "period_locked" : "failed",
        note: row.note,
      });
    }
    byId.set(row.recurringInvoiceId, entry);
  }
  return byId;
}

async function toPublicWithIssues(rows: RecurringRow[]): Promise<PublicRecurringInvoice[]> {
  const issues = await loadRunIssues(rows.map((row) => row.id));
  return rows.map((row) => toPublicRecurringInvoice(row, issues.get(row.id)));
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
  return (await toPublicWithIssues([row]))[0];
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
  return toPublicWithIssues(rows);
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
  /** Mails of earlier runs that were tried again, with how each went. */
  sendRetries: SendRetry[];
}

export interface SendRetry {
  recurringInvoiceId: string;
  issueDate: string;
  invoiceId: string;
  sent: boolean;
  sendError: string | null;
}

export interface RunOptions {
  now?: Date;
  /** Restrict to one schedule, for a "run this now" button. */
  recurringInvoiceId?: string;
  /** Injected so the run can be tested without a mail server. */
  send?: (invoiceId: string) => Promise<void>;
}

/**
 * What one run billed on `issueDate` will total, VAT included: the same rate
 * adjustment and seller rule the run applies, so the preview the user confirms
 * matches the invoice the customer gets (F01). If the rule would refuse the
 * lines the run fails too; the preview then falls back to the stored rates.
 */
export function previewRunGrossCents(
  lines: Array<{ quantityMilli: number; unitPriceCents: number; vatRatePermille: number }>,
  issueDate: string,
  vatRegistered: boolean
): number {
  const adjusted = lines.map((line) => ({
    ...line,
    vatRatePermille: adjustVatRateForDate(line.vatRatePermille, issueDate),
  }));
  let billed = adjusted;
  try {
    billed = applySellerVatRules(adjusted, { vatRegistered, issueDate });
  } catch (error) {
    if (!(error instanceof InvoiceValidationError)) throw error;
  }
  return computeInvoiceTotals(billed).grossCents;
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
  const scope = options.recurringInvoiceId ? { id: options.recurringInvoiceId } : {};

  const out: Pick<RunResult, "generated" | "skipped"> = { generated: [], skipped: [] };
  const truncated: string[] = [];
  const sendRetries: SendRetry[] = [];

  // A closed account bills no one, whatever its schedules still say.
  const owner = await prisma.user.findUnique({ where: { id: userId }, select: { accessDisabledAt: true } });
  if (!owner || owner.accessDisabledAt) return { generated: [], skipped: [], truncated, sendRetries };

  // 1. A mail that failed in a recent run is tried again before anything new.
  if (options.send) await retryFailedSends(userId, scope, now, options.send, sendRetries);

  // 2. Occurrences a closed month held back are made as soon as the month is
  //    open, oldest first, so the numbers follow the dates.
  const lockedThrough = await getLockedThrough(userId);
  const missed = await prisma.recurringInvoiceRun.findMany({
    where: { status: "skipped_locked", recurringInvoice: { userId, active: true, ...scope } },
    orderBy: { issueDate: "asc" },
    include: { recurringInvoice: { include: { lines: { orderBy: { sortOrder: "asc" } } } } },
  });
  for (const row of missed) {
    const issueDate = iso(row.issueDate)!;
    if (isDateLocked(lockedThrough, issueDate)) continue;
    // One run wins the right to make it; the loser sees count 0. The row's
    // clock restarts: any retry window counts from the recovery, not from the
    // run that held the date back.
    const claim = await prisma.recurringInvoiceRun.updateMany({
      where: { id: row.id, status: "skipped_locked" },
      data: { status: "created", note: null, createdAt: now },
    });
    if (claim.count === 0) continue;
    // A recovered invoice can belong to a month the owner has already filed
    // for, so it waits as a draft; the owner sends it from the list.
    await fulfilOccurrence(userId, row.recurringInvoice, issueDate, row.id, options, out, { recovered: true });
  }

  const schedules = await prisma.recurringInvoice.findMany({
    where: {
      userId,
      active: true,
      nextRunAt: { not: null, lte: isoDateToUtc(today) },
      ...scope,
    },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });

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
          out.skipped.push({
            recurringInvoiceId: schedule.id,
            issueDate,
            reason: "already_generated",
          });
          continue;
        }
        throw error;
      }
      await fulfilOccurrence(userId, schedule, issueDate, claimed.id, options, out);
    }

    await prisma.recurringInvoice.update({
      where: { id: schedule.id },
      data: { nextRunAt: plan.nextRun ? isoDateToUtc(plan.nextRun) : null },
    });
  }

  return { generated: out.generated, skipped: out.skipped, truncated, sendRetries };
}

type ScheduleToRun = {
  id: string;
  customerId: string;
  paymentTermDays: number;
  notes: string | null;
  autoSend: boolean;
  lines: Array<{
    description: string;
    quantityMilli: number;
    unit: string;
    unitPriceCents: number;
    vatRatePermille: number;
  }>;
};

/**
 * Makes the invoice for one claimed occurrence and records the outcome on its
 * run row: created, created_send_failed (the invoice exists, the mail did not
 * leave), skipped_locked (a closed month; kept so it can be made once the month
 * opens) or failed.
 */
async function fulfilOccurrence(
  userId: string,
  schedule: ScheduleToRun,
  issueDate: string,
  runId: string,
  options: RunOptions,
  out: Pick<RunResult, "generated" | "skipped">,
  { recovered = false }: { recovered?: boolean } = {}
): Promise<void> {
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
    if (schedule.autoSend && options.send && !recovered) {
      try {
        await options.send(invoice.id);
        sent = true;
      } catch (error) {
        // The invoice exists; only the delivery failed.
        sendError = errorText(error, "Lähetys epäonnistui");
      }
    }

    await prisma.recurringInvoiceRun.update({
      where: { id: runId },
      data: {
        invoiceId: invoice.id,
        status: sendError ? "created_send_failed" : "created",
        note: sendError,
      },
    });

    out.generated.push({
      recurringInvoiceId: schedule.id,
      issueDate,
      invoice,
      sent,
      sendError,
    });
  } catch (error) {
    const locked = error instanceof PeriodLockedError;
    await prisma.recurringInvoiceRun.update({
      where: { id: runId },
      data: {
        status: locked ? "skipped_locked" : "failed",
        note: errorText(error),
      },
    });
    out.skipped.push({
      recurringInvoiceId: schedule.id,
      issueDate,
      reason: locked ? "period_locked" : "failed",
      detail: errorText(error),
    });
  }
}

/**
 * Tries the mail again for invoices a recent run made but could not send. Only
 * runs younger than SEND_RETRY_WINDOW_MS and invoices that are still drafts are
 * touched; past that a person sends it from the invoice.
 */
async function retryFailedSends(
  userId: string,
  scope: { id?: string },
  now: Date,
  send: (invoiceId: string) => Promise<void>,
  out: SendRetry[]
): Promise<void> {
  const rows = await prisma.recurringInvoiceRun.findMany({
    where: {
      status: "created_send_failed",
      invoiceId: { not: null },
      createdAt: { gte: new Date(now.getTime() - SEND_RETRY_WINDOW_MS) },
      invoice: { status: "draft" },
      recurringInvoice: { userId, active: true, autoSend: true, ...scope },
    },
    orderBy: { issueDate: "asc" },
    select: { id: true, recurringInvoiceId: true, issueDate: true, invoiceId: true },
  });
  for (const row of rows) {
    const base = {
      recurringInvoiceId: row.recurringInvoiceId,
      issueDate: iso(row.issueDate)!,
      invoiceId: row.invoiceId!,
    };
    // The rows were loaded a moment ago. An overlapping run (cron and "run now")
    // may have mailed this one since, so look again right before sending.
    const stillOwed = await prisma.recurringInvoiceRun.findFirst({
      where: { id: row.id, status: "created_send_failed", invoice: { status: "draft" } },
      select: { id: true },
    });
    if (!stillOwed) continue;
    try {
      await send(row.invoiceId!);
      await prisma.recurringInvoiceRun.updateMany({
        where: { id: row.id, status: "created_send_failed" },
        data: { status: "created", note: null },
      });
      out.push({ ...base, sent: true, sendError: null });
    } catch (error) {
      const sendError = errorText(error, "Lähetys epäonnistui");
      await prisma.recurringInvoiceRun.updateMany({
        where: { id: row.id, status: "created_send_failed" },
        data: { note: sendError },
      });
      out.push({ ...base, sent: false, sendError });
    }
  }
}

/**
 * Occurrences a closed month held back that can be made now: the month is open
 * again. Keyed by schedule, dates oldest first.
 */
export async function retryableMissedDates(
  userId: string,
  recurringInvoiceId?: string
): Promise<Map<string, string[]>> {
  const lockedThrough = await getLockedThrough(userId);
  const rows = await prisma.recurringInvoiceRun.findMany({
    where: {
      status: "skipped_locked",
      recurringInvoice: {
        userId,
        active: true,
        ...(recurringInvoiceId ? { id: recurringInvoiceId } : {}),
      },
    },
    orderBy: { issueDate: "asc" },
    select: { recurringInvoiceId: true, issueDate: true },
  });
  const byId = new Map<string, string[]>();
  for (const row of rows) {
    const issueDate = iso(row.issueDate)!;
    if (isDateLocked(lockedThrough, issueDate)) continue;
    byId.set(row.recurringInvoiceId, [...(byId.get(row.recurringInvoiceId) ?? []), issueDate]);
  }
  return byId;
}

/** Schedules with something to make now: a run that has arrived or a month that opened again. */
export async function countDueRecurringInvoices(
  userId: string,
  now: Date = new Date()
): Promise<number> {
  const due = await prisma.recurringInvoice.findMany({
    where: {
      userId,
      active: true,
      nextRunAt: { not: null, lte: isoDateToUtc(now.toISOString().slice(0, 10)) },
    },
    select: { id: true },
  });
  const ids = new Set(due.map((row) => row.id));
  for (const id of (await retryableMissedDates(userId)).keys()) ids.add(id);
  return ids.size;
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
