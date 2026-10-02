/**
 * Recurring purchase invoices (toistuvat ostolaskut): rent, a subscription or
 * another routine expense becomes a purchase invoice every period, ready to pay
 * and to match to the bank row.
 *
 * Each period is one RecurringPurchaseRun row keyed by (template, "YYYY-MM" of
 * the issue date) under a unique index, so a period is never created twice -
 * a retried cron, the worker and "Luo nyt" at once all lose at the database.
 * The invoice itself goes through createPurchaseInvoice: the same validation,
 * VAT arithmetic and period lock as an invoice typed in by hand.
 *
 * Dates are calendar dates in Europe/Helsinki ("today" is helsinkiCalendarDate),
 * stored as UTC midnights like every other invoice date.
 */
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  errorText,
} from "./api-errors";
import { centsToEuros } from "./money";
import {
  helsinkiCalendarDate,
  isoDateSchema,
  isoDateToUtc,
  moneySchema,
} from "./validation";
import { PeriodLockedError } from "./period-lock";
import { adjustVatRateForDate } from "./invoices";
import {
  createPurchaseInvoice,
  prepareReference,
  prepareSupplier,
  purchaseAmountsFromRate,
} from "./purchase-invoices";
import {
  RECURRENCE_INTERVALS,
  daysInMonth,
  firstRun,
  nextRunAfter,
  type RecurrenceInterval,
  type Schedule,
} from "./recurrence";

type Db = Prisma.TransactionClient | typeof prisma;

export const RECURRING_PURCHASE_VAT_RATES = [0, 10, 13.5, 14, 25.5] as const;
/** A run makes at most this many periods; older missed ones are skipped and reported. */
export const MAX_PURCHASE_CATCH_UP = 3;

const DAY_MESSAGE = "Laskun päivä on 1–28.";
const DUE_DAYS_MESSAGE = "Maksuaika on 0–90 päivää.";
const VAT_RATE_MESSAGE = "ALV-kanta on 0, 10, 13,5, 14 tai 25,5 %.";
const INTERVAL_MESSAGE = "Toistoväli on kuukausi, neljännesvuosi tai vuosi.";
const NOT_FOUND = "Toistuvaa ostolaskua ei löytynyt.";

const fields = {
  supplierName: z.string().trim().min(1, "Toimittajan nimi puuttuu").max(120),
  supplierBusinessId: z.string().trim().max(20).nullish(),
  supplierIban: z.string().trim().max(42).nullish(),
  reference: z.string().trim().max(30).nullish(),
  category: z.string().trim().max(60).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  grossAmount: moneySchema,
  vatRate: z
    .number({ error: VAT_RATE_MESSAGE })
    .refine(
      (rate) =>
        (RECURRING_PURCHASE_VAT_RATES as readonly number[]).includes(rate),
      VAT_RATE_MESSAGE,
    ),
  interval: z.enum(["monthly", "quarterly", "yearly"], {
    error: INTERVAL_MESSAGE,
  }),
  dayOfMonth: z
    .number({ error: DAY_MESSAGE })
    .int(DAY_MESSAGE)
    .min(1, DAY_MESSAGE)
    .max(28, DAY_MESSAGE),
  dueDays: z
    .number({ error: DUE_DAYS_MESSAGE })
    .int(DUE_DAYS_MESSAGE)
    .min(0, DUE_DAYS_MESSAGE)
    .max(90, DUE_DAYS_MESSAGE),
  startDate: isoDateSchema,
  endDate: isoDateSchema.nullish(),
  fromPurchaseInvoiceId: z.string().uuid().nullish(),
};

export const createRecurringPurchaseSchema = z.object(fields);

export const patchRecurringPurchaseSchema = z
  .object({
    ...createRecurringPurchaseSchema.partial().shape,
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Ei muutettavia kenttiä");

export type RecurringPurchaseInput = z.infer<
  typeof createRecurringPurchaseSchema
>;
export type RecurringPurchasePatch = z.infer<
  typeof patchRecurringPurchaseSchema
>;

export interface RecurringPurchaseView {
  id: string;
  supplierName: string;
  supplierBusinessId: string | null;
  supplierIban: string | null;
  reference: string | null;
  category: string | null;
  notes: string | null;
  grossAmount: number;
  vatRate: number;
  netAmount: number;
  vatAmount: number;
  interval: RecurrenceInterval;
  dayOfMonth: number;
  dueDays: number;
  startDate: string;
  endDate: string | null;
  active: boolean;
  nextRunDate: string;
  lastRunAt: string | null;
  runCount: number;
  lastInvoice: {
    id: string;
    issueDate: string;
    dueDate: string;
    status: string;
    grossAmount: number;
  } | null;
}

export interface RecurringPurchaseOccurrence {
  recurringPurchaseId: string;
  /** "YYYY-MM" of the issue date. */
  periodKey: string;
  issueDate: string;
}

export interface RecurringPurchaseRunResult {
  created: Array<RecurringPurchaseOccurrence & { purchaseInvoiceId: string }>;
  /**
   * period_locked: the month is closed, nothing was created and the schedule
   * moved on. already_created: the period has its invoice. too_old: more than
   * MAX_PURCHASE_CATCH_UP periods were owed; the older ones are not created.
   * failed: the invoice was refused for another reason; the schedule waits there.
   */
  skipped: Array<
    RecurringPurchaseOccurrence & {
      reason: "period_locked" | "already_created" | "too_old" | "failed";
      detail?: string;
    }
  >;
}

type TemplateRow = {
  id: string;
  userId: string;
  supplierName: string;
  supplierBusinessId: string | null;
  supplierIban: string | null;
  reference: string | null;
  category: string | null;
  notes: string | null;
  grossCents: number;
  vatRate: number;
  interval: string;
  dayOfMonth: number;
  dueDays: number;
  startDate: Date;
  endDate: Date | null;
  active: boolean;
  nextRunDate: Date;
  lastRunAt: Date | null;
};

const viewInclude = {
  _count: { select: { runs: true } },
  invoices: {
    orderBy: [{ issueDate: "desc" as const }, { createdAt: "desc" as const }],
    take: 1,
    select: {
      id: true,
      issueDate: true,
      dueDate: true,
      status: true,
      grossCents: true,
    },
  },
};

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const value = isoDateToUtc(date);
  value.setUTCDate(value.getUTCDate() + days);
  return iso(value);
}

function lastDayOfMonth(date: string): string {
  const [year, month] = date.split("-").map(Number);
  return `${date.slice(0, 8)}${String(daysInMonth(year, month)).padStart(2, "0")}`;
}

function periodKey(issueDate: string): string {
  return issueDate.slice(0, 7);
}

function scheduleOf(
  row: Pick<TemplateRow, "interval" | "dayOfMonth" | "startDate" | "endDate">,
): Schedule {
  return {
    interval: row.interval as RecurrenceInterval,
    anchorDay: row.dayOfMonth,
    startDate: iso(row.startDate),
    endDate: row.endDate ? iso(row.endDate) : null,
  };
}

/** The rules the route schema also checks, for callers that do not come through it. */
function validateTemplate(input: {
  interval: string;
  dayOfMonth: number;
  dueDays: number;
  vatRate: number;
  startDate: string;
  endDate?: string | null;
}): void {
  if (!RECURRENCE_INTERVALS.includes(input.interval as RecurrenceInterval)) {
    throw new ValidationError(INTERVAL_MESSAGE);
  }
  if (
    !Number.isInteger(input.dayOfMonth) ||
    input.dayOfMonth < 1 ||
    input.dayOfMonth > 28
  ) {
    throw new ValidationError(DAY_MESSAGE);
  }
  if (
    !Number.isInteger(input.dueDays) ||
    input.dueDays < 0 ||
    input.dueDays > 90
  ) {
    throw new ValidationError(DUE_DAYS_MESSAGE);
  }
  if (
    !(RECURRING_PURCHASE_VAT_RATES as readonly number[]).includes(input.vatRate)
  ) {
    throw new ValidationError(VAT_RATE_MESSAGE);
  }
  if (input.endDate && input.endDate < input.startDate) {
    throw new ValidationError("Päättymispäivä ei voi olla ennen alkupäivää.");
  }
}

function toView(
  row: TemplateRow & {
    _count: { runs: number };
    invoices: Array<{
      id: string;
      issueDate: Date;
      dueDate: Date;
      status: string;
      grossCents: number;
    }>;
  },
): RecurringPurchaseView {
  const amounts = purchaseAmountsFromRate(
    centsToEuros(row.grossCents),
    row.vatRate,
  );
  const last = row.invoices[0];
  return {
    id: row.id,
    supplierName: row.supplierName,
    supplierBusinessId: row.supplierBusinessId,
    supplierIban: row.supplierIban,
    reference: row.reference,
    category: row.category,
    notes: row.notes,
    grossAmount: centsToEuros(amounts.grossCents),
    vatRate: row.vatRate,
    netAmount: centsToEuros(amounts.netCents),
    vatAmount: centsToEuros(amounts.vatCents),
    interval: row.interval as RecurrenceInterval,
    dayOfMonth: row.dayOfMonth,
    dueDays: row.dueDays,
    startDate: iso(row.startDate),
    endDate: row.endDate ? iso(row.endDate) : null,
    active: row.active,
    nextRunDate: iso(row.nextRunDate),
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    runCount: row._count.runs,
    lastInvoice: last
      ? {
          id: last.id,
          issueDate: iso(last.issueDate),
          dueDate: iso(last.dueDate),
          status: last.status,
          grossAmount: centsToEuros(last.grossCents),
        }
      : null,
  };
}

export async function listRecurringPurchases(
  userId: string,
): Promise<RecurringPurchaseView[]> {
  const rows = await prisma.recurringPurchase.findMany({
    where: { userId },
    include: viewInclude,
    orderBy: [{ active: "desc" }, { nextRunDate: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toView);
}

export async function getRecurringPurchase(
  userId: string,
  id: string,
  db: Db = prisma,
): Promise<RecurringPurchaseView> {
  const row = await db.recurringPurchase.findFirst({
    where: { id, userId },
    include: viewInclude,
  });
  if (!row) throw new NotFoundError(NOT_FOUND);
  return toView(row);
}

async function requireOwned(
  userId: string,
  id: string,
  db: Db = prisma,
): Promise<TemplateRow> {
  const row = await db.recurringPurchase.findFirst({ where: { id, userId } });
  if (!row) throw new NotFoundError(NOT_FOUND);
  return row;
}

/** Saves the supplier and amount fields the way a purchase invoice would store them. */
function templateFields(input: {
  supplierName: string;
  supplierBusinessId?: string | null;
  supplierIban?: string | null;
  reference?: string | null;
  category?: string | null;
  notes?: string | null;
  grossAmount: number;
  vatRate: number;
}) {
  const supplierName = input.supplierName.trim();
  if (!supplierName) throw new ValidationError("Toimittajan nimi puuttuu.");
  const { businessId, iban } = prepareSupplier(input);
  const { grossCents } = purchaseAmountsFromRate(
    input.grossAmount,
    input.vatRate,
  );
  return {
    supplierName,
    supplierBusinessId: businessId,
    supplierIban: iban,
    reference: prepareReference(input.reference),
    category: input.category?.trim() || null,
    notes: input.notes?.trim() || null,
    grossCents,
    vatRate: input.vatRate,
  };
}

/**
 * Marks an existing purchase invoice as the template's run for the period of
 * its issue date, so that period is not created again.
 */
async function markInvoiceAsRun(
  tx: Prisma.TransactionClient,
  userId: string,
  recurringPurchaseId: string,
  purchaseInvoiceId: string,
  now: Date,
): Promise<void> {
  const source = await tx.purchaseInvoice.findFirst({
    where: { id: purchaseInvoiceId, userId },
    select: { id: true, issueDate: true, recurringPurchaseId: true },
  });
  if (!source) throw new NotFoundError("Ostolaskua ei löytynyt.");
  if (
    source.recurringPurchaseId &&
    source.recurringPurchaseId !== recurringPurchaseId
  ) {
    throw new ConflictError(
      "Ostolasku kuuluu jo toiseen toistuvaan ostolaskuun.",
      "PURCHASE_ALREADY_RECURRING",
    );
  }
  const key = periodKey(iso(source.issueDate));
  const taken = await tx.recurringPurchaseRun.findUnique({
    where: {
      recurringPurchaseId_periodKey: { recurringPurchaseId, periodKey: key },
    },
    select: { purchaseInvoiceId: true },
  });
  if (taken && taken.purchaseInvoiceId !== source.id) {
    throw new ConflictError(
      "Tämän kauden ostolasku on jo luotu.",
      "RECURRING_PERIOD_DONE",
    );
  }
  if (!taken) {
    await tx.recurringPurchaseRun.create({
      data: {
        recurringPurchaseId,
        periodKey: key,
        purchaseInvoiceId: source.id,
      },
    });
  }
  await tx.purchaseInvoice.update({
    where: { id: source.id },
    data: { recurringPurchaseId },
  });
  await tx.recurringPurchase.update({
    where: { id: recurringPurchaseId },
    data: { lastRunAt: now },
  });
}

/**
 * Creates the template. `fromPurchaseInvoiceId` marks that invoice as the run of
 * its period (it is not created again). A first issue date that is today or
 * past is created at once, through the same run as the scheduled one.
 * `db` is the transaction of an idempotent request; without it the create opens its own.
 */
export async function createRecurringPurchase(
  userId: string,
  input: RecurringPurchaseInput,
  db?: Prisma.TransactionClient,
  now: Date = new Date(),
): Promise<RecurringPurchaseView> {
  validateTemplate(input);
  const data = templateFields(input);
  const schedule: Schedule = {
    interval: input.interval,
    anchorDay: input.dayOfMonth,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
  };
  const first = firstRun(schedule);

  const write = async (tx: Prisma.TransactionClient) => {
    const row = await tx.recurringPurchase.create({
      data: {
        userId,
        ...data,
        interval: input.interval,
        dayOfMonth: input.dayOfMonth,
        dueDays: input.dueDays,
        startDate: isoDateToUtc(input.startDate),
        endDate: input.endDate ? isoDateToUtc(input.endDate) : null,
        nextRunDate: isoDateToUtc(first),
      },
    });
    if (input.fromPurchaseInvoiceId) {
      await markInvoiceAsRun(
        tx,
        userId,
        row.id,
        input.fromPurchaseInvoiceId,
        now,
      );
    }
    await runTemplate(userId, row, helsinkiCalendarDate(now), now, tx, {
      includeCurrentMonth: false,
    });
    return getRecurringPurchase(userId, row.id, tx);
  };

  return db ? write(db) : prisma.$transaction(write);
}

export async function updateRecurringPurchase(
  userId: string,
  id: string,
  input: RecurringPurchasePatch,
  now: Date = new Date(),
): Promise<RecurringPurchaseView> {
  const existing = await requireOwned(userId, id);

  const merged = {
    supplierName: input.supplierName ?? existing.supplierName,
    supplierBusinessId:
      input.supplierBusinessId !== undefined
        ? input.supplierBusinessId
        : existing.supplierBusinessId,
    supplierIban:
      input.supplierIban !== undefined
        ? input.supplierIban
        : existing.supplierIban,
    reference:
      input.reference !== undefined ? input.reference : existing.reference,
    category: input.category !== undefined ? input.category : existing.category,
    notes: input.notes !== undefined ? input.notes : existing.notes,
    grossAmount: input.grossAmount ?? centsToEuros(existing.grossCents),
    vatRate: input.vatRate ?? existing.vatRate,
    interval: input.interval ?? (existing.interval as RecurrenceInterval),
    dayOfMonth: input.dayOfMonth ?? existing.dayOfMonth,
    dueDays: input.dueDays ?? existing.dueDays,
    startDate: input.startDate ?? iso(existing.startDate),
    endDate:
      input.endDate !== undefined
        ? input.endDate
        : existing.endDate
          ? iso(existing.endDate)
          : null,
    active: input.active ?? existing.active,
  };
  validateTemplate(merged);

  const schedule: Schedule = {
    interval: merged.interval,
    anchorDay: merged.dayOfMonth,
    startDate: merged.startDate,
    endDate: merged.endDate,
  };
  let next = iso(existing.nextRunDate);
  const scheduleChanged =
    input.interval !== undefined ||
    input.dayOfMonth !== undefined ||
    input.startDate !== undefined ||
    input.endDate !== undefined;
  if (scheduleChanged) {
    // Periods already run are history: the next issue date is the first one of
    // the new schedule in a period after the last one run.
    const lastRun = await prisma.recurringPurchaseRun.findFirst({
      where: { recurringPurchaseId: id },
      orderBy: { periodKey: "desc" },
      select: { periodKey: true },
    });
    next = firstRun(schedule);
    while (lastRun && periodKey(next) <= lastRun.periodKey)
      next = nextRunAfter(schedule, next);
  }
  if (merged.active && !existing.active) {
    // A paused template resumes from this month: the months it was paused for
    // are not created afterwards.
    const thisMonth = periodKey(helsinkiCalendarDate(now));
    while (periodKey(next) < thisMonth) next = nextRunAfter(schedule, next);
  }

  const data = {
    ...templateFields(merged),
    interval: merged.interval,
    dayOfMonth: merged.dayOfMonth,
    dueDays: merged.dueDays,
    startDate: isoDateToUtc(merged.startDate),
    endDate: merged.endDate ? isoDateToUtc(merged.endDate) : null,
    active: merged.active,
    nextRunDate: isoDateToUtc(next),
  };
  await prisma.$transaction(async (tx) => {
    await tx.recurringPurchase.update({ where: { id }, data });
    if (input.fromPurchaseInvoiceId) {
      await markInvoiceAsRun(tx, userId, id, input.fromPurchaseInvoiceId, now);
    }
  });
  return getRecurringPurchase(userId, id);
}

/** Deletes the template. Invoices it already created stay; they only lose the link. */
export async function deleteRecurringPurchase(
  userId: string,
  id: string,
): Promise<void> {
  await requireOwned(userId, id);
  await prisma.recurringPurchase.delete({ where: { id } });
}

/**
 * Creates one period's purchase invoice and its run row together. In an outer
 * transaction (`db`) any refusal other than a closed month aborts that
 * transaction; on its own each period gets a transaction of its own.
 */
async function fulfilPeriod(
  userId: string,
  template: TemplateRow,
  issueDate: string,
  db: Prisma.TransactionClient | null,
): Promise<
  | { ok: true; purchaseInvoiceId: string }
  | {
      ok: false;
      reason: "period_locked" | "already_created" | "failed";
      detail?: string;
    }
> {
  const key = periodKey(issueDate);
  const done = await (db ?? prisma).recurringPurchaseRun.findUnique({
    where: {
      recurringPurchaseId_periodKey: {
        recurringPurchaseId: template.id,
        periodKey: key,
      },
    },
    select: { id: true },
  });
  if (done) return { ok: false, reason: "already_created" };

  const create = async (tx: Prisma.TransactionClient) => {
    // A template saved at 14 % follows the reduced rate to 13,5 % from 1.1.2026,
    // exactly as a recurring sales invoice does.
    const rate =
      adjustVatRateForDate(Math.round(template.vatRate * 10), issueDate) / 10;
    const amounts = purchaseAmountsFromRate(
      centsToEuros(template.grossCents),
      rate,
    );
    const invoice = await createPurchaseInvoice(
      userId,
      {
        supplierName: template.supplierName,
        supplierBusinessId: template.supplierBusinessId,
        supplierIban: template.supplierIban,
        reference: template.reference,
        issueDate,
        dueDate: addDays(issueDate, template.dueDays),
        gross: centsToEuros(amounts.grossCents),
        vat: centsToEuros(amounts.vatCents),
        category: template.category,
        notes: template.notes,
        recurringPurchaseId: template.id,
      },
      tx,
    );
    await tx.recurringPurchaseRun.create({
      data: {
        recurringPurchaseId: template.id,
        periodKey: key,
        purchaseInvoiceId: invoice.id,
      },
    });
    return invoice.id;
  };

  try {
    const purchaseInvoiceId = db
      ? await create(db)
      : await prisma.$transaction(create);
    return { ok: true, purchaseInvoiceId };
  } catch (error) {
    // The lock is checked before anything is written, so it is safe to go on.
    if (error instanceof PeriodLockedError) {
      return { ok: false, reason: "period_locked", detail: error.message };
    }
    if (db) throw error;
    if ((error as { code?: string }).code === "P2002")
      return { ok: false, reason: "already_created" };
    return { ok: false, reason: "failed", detail: errorText(error) };
  }
}

/**
 * Creates every period of one template owed up to `today` (or, for "Luo nyt",
 * up to the end of this month) and moves nextRunDate on.
 */
async function runTemplate(
  userId: string,
  template: TemplateRow,
  today: string,
  now: Date,
  db: Prisma.TransactionClient | null,
  { includeCurrentMonth }: { includeCurrentMonth: boolean },
  out: RecurringPurchaseRunResult = { created: [], skipped: [] },
): Promise<RecurringPurchaseRunResult> {
  const schedule = scheduleOf(template);
  const limit = includeCurrentMonth ? lastDayOfMonth(today) : today;
  const owed: string[] = [];
  let cursor = iso(template.nextRunDate);
  while (cursor <= limit && (!schedule.endDate || cursor <= schedule.endDate)) {
    owed.push(cursor);
    cursor = nextRunAfter(schedule, cursor);
  }
  if (owed.length === 0) return out;

  const occurrence = (issueDate: string): RecurringPurchaseOccurrence => ({
    recurringPurchaseId: template.id,
    periodKey: periodKey(issueDate),
    issueDate,
  });
  const tooOld = owed.slice(
    0,
    Math.max(0, owed.length - MAX_PURCHASE_CATCH_UP),
  );
  for (const issueDate of tooOld)
    out.skipped.push({ ...occurrence(issueDate), reason: "too_old" });

  let nextRun = cursor;
  let created = false;
  for (const issueDate of owed.slice(tooOld.length)) {
    const result = await fulfilPeriod(userId, template, issueDate, db);
    if (result.ok) {
      created = true;
      out.created.push({
        ...occurrence(issueDate),
        purchaseInvoiceId: result.purchaseInvoiceId,
      });
      continue;
    }
    out.skipped.push({
      ...occurrence(issueDate),
      reason: result.reason,
      detail: result.detail,
    });
    if (result.reason === "failed") {
      // Not a closed month: something a person must fix. The schedule waits here.
      nextRun = issueDate;
      break;
    }
  }

  await (db ?? prisma).recurringPurchase.update({
    where: { id: template.id },
    data: {
      nextRunDate: isoDateToUtc(nextRun),
      ...(created ? { lastRunAt: now } : {}),
    },
  });
  return out;
}

export interface RunRecurringPurchasesOptions {
  now?: Date;
  /** Restrict to one template ("Luo nyt"). */
  recurringPurchaseId?: string;
  /** "Luo nyt": this month's period is made now even when its day is still ahead. */
  includeCurrentMonth?: boolean;
  /** The transaction of an idempotent request. */
  db?: Prisma.TransactionClient;
}

/** Creates every owed period of the owner's active templates. */
export async function runRecurringPurchases(
  userId: string,
  options: RunRecurringPurchasesOptions = {},
): Promise<RecurringPurchaseRunResult> {
  const now = options.now ?? new Date();
  const today = helsinkiCalendarDate(now);
  const out: RecurringPurchaseRunResult = { created: [], skipped: [] };
  const db = options.db ?? null;
  const reader = db ?? prisma;

  // A closed account records nothing new, whatever its templates still say.
  const owner = await reader.user.findUnique({
    where: { id: userId },
    select: { accessDisabledAt: true },
  });
  if (!owner || owner.accessDisabledAt) return out;

  const limit = options.includeCurrentMonth ? lastDayOfMonth(today) : today;
  const templates = await reader.recurringPurchase.findMany({
    where: {
      userId,
      active: true,
      nextRunDate: { lte: isoDateToUtc(limit) },
      ...(options.recurringPurchaseId
        ? { id: options.recurringPurchaseId }
        : {}),
    },
    orderBy: [{ nextRunDate: "asc" }, { createdAt: "asc" }],
  });
  for (const template of templates) {
    await runTemplate(
      userId,
      template,
      today,
      now,
      db,
      {
        includeCurrentMonth: options.includeCurrentMonth ?? false,
      },
      out,
    );
  }
  return out;
}

/**
 * "Luo nyt": creates the template's current period if it has not been created
 * yet (owed periods first, then this month's even if its day is still ahead).
 */
export async function runRecurringPurchaseNow(
  userId: string,
  id: string,
  db?: Prisma.TransactionClient,
  now: Date = new Date(),
): Promise<{
  created: boolean;
  purchaseInvoiceId?: string;
  skipped?: Array<{ periodKey: string; issueDate: string; reason: string }>;
}> {
  const template = await requireOwned(userId, id, db ?? prisma);
  if (!template.active) {
    throw new AppError(
      "Toistuva ostolasku on pysäytetty.",
      "RECURRING_INACTIVE",
      409,
    );
  }
  const result = await runRecurringPurchases(userId, {
    now,
    recurringPurchaseId: id,
    includeCurrentMonth: true,
    db,
  });
  const last = result.created[result.created.length - 1];
  const skipped = result.skipped
    .filter((entry) => entry.reason !== "already_created")
    .map(({ periodKey: key, issueDate, reason }) => ({
      periodKey: key,
      issueDate,
      reason,
    }));
  return {
    created: Boolean(last),
    ...(last ? { purchaseInvoiceId: last.purchaseInvoiceId } : {}),
    ...(skipped.length ? { skipped } : {}),
  };
}

export interface DueRecurringPurchasesSummary {
  users: number;
  created: number;
  skipped: number;
  /** Periods that fell in a closed month: not created, reported here. */
  periodLocked: Array<{
    userId: string;
    recurringPurchaseId: string;
    periodKey: string;
  }>;
  failed: Array<{
    userId: string;
    recurringPurchaseId: string;
    periodKey: string;
    error: string;
  }>;
  errors: Array<{ userId: string; error: string }>;
}

/**
 * The scheduled job (cron route and worker): every owner with a template due
 * today. One owner's failure does not stop the others.
 */
export async function runDueRecurringPurchases(
  now: Date = new Date(),
): Promise<DueRecurringPurchasesSummary> {
  const today = helsinkiCalendarDate(now);
  const owners = await prisma.recurringPurchase.findMany({
    where: {
      active: true,
      nextRunDate: { lte: isoDateToUtc(today) },
      user: { accessDisabledAt: null },
    },
    select: { userId: true },
    distinct: ["userId"],
  });
  const summary: DueRecurringPurchasesSummary = {
    users: owners.length,
    created: 0,
    skipped: 0,
    periodLocked: [],
    failed: [],
    errors: [],
  };
  for (const { userId } of owners) {
    try {
      const result = await runRecurringPurchases(userId, { now });
      summary.created += result.created.length;
      summary.skipped += result.skipped.length;
      for (const entry of result.skipped) {
        if (entry.reason === "period_locked") {
          summary.periodLocked.push({
            userId,
            recurringPurchaseId: entry.recurringPurchaseId,
            periodKey: entry.periodKey,
          });
        } else if (entry.reason === "failed") {
          summary.failed.push({
            userId,
            recurringPurchaseId: entry.recurringPurchaseId,
            periodKey: entry.periodKey,
            error: entry.detail ?? "",
          });
        }
      }
    } catch (error) {
      summary.errors.push({ userId, error: errorText(error) });
    }
  }
  return summary;
}
