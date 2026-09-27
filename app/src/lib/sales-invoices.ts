/**
 * Sales invoices: numbering, totals, lifecycle and bank reconciliation.
 *
 * Arithmetic lives in ./invoices (pure). This module owns persistence and the
 * rules that need the database: the per-user invoice number sequence, which
 * edits a non-draft invoice still allows, and how a bank row becomes a payment.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { AppError, ConflictError, NotFoundError, ValidationError } from "./api-errors";
import { expectedUpdatedAtDate, versionConflict } from "./edit-conflict";
import { centsToEuros, eurosToCents } from "./money";
import { formatEur } from "./format";
import { allocateInvoiceNumber, peekInvoiceNumber } from "./invoice-sequence";
import { helsinkiCalendarDate, isoDateToUtc } from "./validation";
import { normalizeReference, referenceForInvoice } from "./finnish-reference";
import {
  buildAgingReport,
  canTransition,
  computeInvoiceTotals as computeTotalsUnsafe,
  InvoiceValidationError,
  DEFAULT_PAYMENT_TERM_DAYS,
  displayStatus,
  dueDateFor,
  overdueBefore,
  openPosition,
  type AgingReport,
  type InvoiceDisplayStatus,
  type InvoiceLineInput,
  type InvoiceStatus,
} from "./invoices";
import {
  customerFromCustomer,
  parsePartySnapshot,
  sellerFromUser,
  serializePartySnapshot,
} from "./invoice-snapshot";
import { requireActiveCustomer } from "./customers";
import { assertPeriodOpen, PeriodLockedError } from "./period-lock";
import type { InvoicePdfData } from "./invoice-pdf";

export interface InvoiceLinePayload {
  description: string;
  /** Units, up to three decimals. */
  quantity: number;
  unit?: string;
  unitPrice: number;
  vatRate: number; // percent, e.g. 25.5
}

export interface CreateInvoiceInput {
  customerId: string;
  issueDate: string; // YYYY-MM-DD
  paymentTermDays?: number;
  dueDate?: string; // overrides the term when given
  notes?: string | null;
  lines: InvoiceLinePayload[];
}

const MAX_LINES = 200;

/**
 * ./invoices throws its own error type so it stays free of HTTP concerns.
 * Every caller here wants that surfaced as a 400, not a 500.
 */
function computeInvoiceTotals(lines: InvoiceLineInput[]) {
  try {
    return computeTotalsUnsafe(lines);
  } catch (error) {
    if (error instanceof InvoiceValidationError) throw new ValidationError(error.message);
    throw error;
  }
}

function quantityToMilli(quantity: number): number {
  if (!Number.isFinite(quantity) || quantity === 0) {
    throw new ValidationError("Rivin määrä puuttuu.");
  }
  const milli = Math.round(quantity * 1000);
  if (Math.abs(quantity * 1000 - milli) > 1e-6) {
    throw new ValidationError("Määrässä saa olla enintään kolme desimaalia.");
  }
  if (Math.abs(milli) > 100_000_000) {
    throw new ValidationError("Rivin määrä on liian suuri.");
  }
  return milli;
}

function vatRateToPermille(rate: number): number {
  const permille = Math.round(rate * 10);
  if (Math.abs(rate * 10 - permille) > 1e-6) {
    throw new ValidationError("ALV-kanta on virheellinen.");
  }
  return permille;
}

export function toLineInputs(lines: InvoiceLinePayload[]): Array<InvoiceLineInput & {
  description: string;
  unit: string;
}> {
  if (lines.length === 0) throw new ValidationError("Laskulla on oltava vähintään yksi rivi.");
  if (lines.length > MAX_LINES) {
    throw new ValidationError(`Laskulla saa olla enintään ${MAX_LINES} riviä.`);
  }
  return lines.map((line) => {
    const description = line.description?.trim();
    if (!description) throw new ValidationError("Rivin kuvaus puuttuu.");
    return {
      description,
      unit: line.unit?.trim() || "kpl",
      quantityMilli: quantityToMilli(line.quantity),
      unitPriceCents: eurosToCents(line.unitPrice),
      vatRatePermille: vatRateToPermille(line.vatRate),
    };
  });
}

/**
 * Next number in the user's own sequence, without consuming it.
 * Allocation itself happens inside the create transaction.
 */
export async function nextInvoiceNumber(userId: string): Promise<number> {
  return peekInvoiceNumber(userId);
}

const STATUS_FI: Record<string, string> = {
  draft: "Luonnos",
  sent: "Lähetetty",
  paid: "Maksettu",
  credited: "Hyvitetty",
};

function statusFi(status: string): string {
  return STATUS_FI[status] ?? status;
}

async function recordActivity(
  db: Prisma.TransactionClient | typeof prisma,
  invoiceId: string,
  kind: string,
  summary: string
): Promise<void> {
  await db.invoiceActivity.create({ data: { invoiceId, kind, summary } });
}

export interface PublicInvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  vatRate: number;
  net: number;
}

export interface PublicInvoice {
  id: string;
  number: number;
  reference: string;
  status: InvoiceStatus;
  displayStatus: InvoiceDisplayStatus;
  issueDate: string;
  dueDate: string;
  sentAt: string | null;
  paidAt: string | null;
  notes: string | null;
  currency: string;
  net: number;
  vat: number;
  gross: number;
  paid: number;
  open: number;
  closedReason: string | null;
  updatedAt: string;
  documentKind: "invoice" | "credit_note";
  creditsInvoice: { id: string; number: number } | null;
  creditNotes: Array<{ id: string; number: number; status: string }>;
  customer: { id: string; name: string; email: string | null; businessId: string | null };
  lines: PublicInvoiceLine[];
  payments: Array<{
    id: string;
    paidDate: string;
    amount: number;
    source: string;
    transactionId: string | null;
    note: string | null;
  }>;
  sends: Array<{
    id: string;
    toAddress: string;
    status: string;
    attachmentName: string | null;
    gross: number | null;
    error: string | null;
    createdAt: string;
    finishedAt: string | null;
  }>;
  activity: Array<{ id: string; kind: string; summary: string; createdAt: string }>;
}

type InvoiceWithRelations = {
  id: string;
  number: number;
  reference: string;
  status: string;
  issueDate: Date;
  dueDate: Date;
  sentAt: Date | null;
  paidAt: Date | null;
  notes: string | null;
  currency: string;
  netCents: number;
  vatCents: number;
  grossCents: number;
  partySnapshot: string | null;
  closedReason: string | null;
  updatedAt: Date;
  documentKind: string;
  creditsInvoice: { id: string; number: number } | null;
  creditNotes: Array<{ id: string; number: number; status: string }>;
  customer: { id: string; name: string; email: string | null; businessId: string | null };
  lines: Array<{
    id: string;
    description: string;
    quantityMilli: number;
    unit: string;
    unitPriceCents: number;
    vatRatePermille: number;
    netCents: number;
    sortOrder: number;
  }>;
  payments: Array<{
    id: string;
    paidDate: Date;
    amountCents: number;
    source: string;
    transactionId: string | null;
    note: string | null;
  }>;
  emailSends: Array<{
    id: string;
    toAddress: string;
    status: string;
    attachmentName: string | null;
    grossCents: number | null;
    error: string | null;
    createdAt: Date;
    finishedAt: Date | null;
  }>;
  activities: Array<{ id: string; kind: string; summary: string; createdAt: Date }>;
};

const invoiceInclude = {
  customer: { select: { id: true, name: true, email: true, businessId: true } },
  lines: { orderBy: { sortOrder: "asc" as const } },
  payments: { orderBy: { paidDate: "asc" as const } },
  creditsInvoice: { select: { id: true, number: true } },
  creditNotes: {
    select: { id: true, number: true, status: true },
    orderBy: { createdAt: "desc" as const },
  },
  emailSends: { orderBy: { createdAt: "desc" as const } },
  activities: { orderBy: { createdAt: "asc" as const } },
};

export function toPublicInvoice(
  invoice: InvoiceWithRelations,
  now: Date = new Date()
): PublicInvoice {
  const paidCents = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  const position = openPosition({
    status: invoice.status,
    grossCents: invoice.grossCents,
    paidCents,
    closedReason: invoice.closedReason,
  });
  return {
    id: invoice.id,
    number: invoice.number,
    reference: invoice.reference,
    status: invoice.status as InvoiceStatus,
    displayStatus: displayStatus(
      {
        status: invoice.status as InvoiceStatus,
        dueDate: invoice.dueDate,
        documentKind: invoice.documentKind,
      },
      now
    ),
    issueDate: invoice.issueDate.toISOString().slice(0, 10),
    dueDate: invoice.dueDate.toISOString().slice(0, 10),
    sentAt: invoice.sentAt ? invoice.sentAt.toISOString() : null,
    paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
    notes: invoice.notes,
    currency: invoice.currency,
    net: centsToEuros(invoice.netCents),
    vat: centsToEuros(invoice.vatCents),
    gross: centsToEuros(invoice.grossCents),
    paid: centsToEuros(paidCents),
    open: centsToEuros(position.openCents),
    closedReason: invoice.closedReason,
    updatedAt: invoice.updatedAt.toISOString(),
    documentKind: invoice.documentKind === "credit_note" ? "credit_note" : "invoice",
    creditsInvoice: invoice.creditsInvoice,
    creditNotes: invoice.creditNotes,
    customer: invoice.customer,
    lines: invoice.lines.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantityMilli / 1000,
      unit: line.unit,
      unitPrice: centsToEuros(line.unitPriceCents),
      vatRate: line.vatRatePermille / 10,
      net: centsToEuros(line.netCents),
    })),
    payments: invoice.payments.map((payment) => ({
      id: payment.id,
      paidDate: payment.paidDate.toISOString().slice(0, 10),
      amount: centsToEuros(payment.amountCents),
      source: payment.source,
      transactionId: payment.transactionId,
      note: payment.note,
    })),
    sends: invoice.emailSends.map((send) => ({
      id: send.id,
      toAddress: send.toAddress,
      status: send.status,
      attachmentName: send.attachmentName,
      gross: send.grossCents == null ? null : centsToEuros(send.grossCents),
      error: send.error,
      createdAt: send.createdAt.toISOString(),
      finishedAt: send.finishedAt ? send.finishedAt.toISOString() : null,
    })),
    activity: invoice.activities.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      summary: entry.summary,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

type InvoiceWriter = Prisma.TransactionClient | typeof prisma;

async function insertInvoice(
  tx: Prisma.TransactionClient,
  userId: string,
  prepared: {
    customerId: string;
    issueDate: Date;
    dueDate: Date;
    notes: string | null;
    totals: ReturnType<typeof computeInvoiceTotals>;
    lineInputs: ReturnType<typeof toLineInputs>;
  }
): Promise<string> {
  const number = await allocateInvoiceNumber(tx, userId);
  const created = await tx.salesInvoice.create({
    data: {
      userId,
      customerId: prepared.customerId,
      number,
      reference: referenceForInvoice(number),
      issueDate: prepared.issueDate,
      dueDate: prepared.dueDate,
      notes: prepared.notes,
      netCents: prepared.totals.netCents,
      vatCents: prepared.totals.vatCents,
      grossCents: prepared.totals.grossCents,
      lines: {
        create: prepared.lineInputs.map((line, index) => ({
          sortOrder: index,
          description: line.description,
          unit: line.unit,
          quantityMilli: line.quantityMilli,
          unitPriceCents: line.unitPriceCents,
          vatRatePermille: line.vatRatePermille,
          netCents: prepared.totals.lines[index].netCents,
        })),
      },
    },
    select: { id: true },
  });
  await recordActivity(tx, created.id, "created", "Lasku luotiin.");
  return created.id;
}

export async function createInvoice(
  userId: string,
  input: CreateInvoiceInput,
  db?: Prisma.TransactionClient
): Promise<PublicInvoice> {
  const customer = await requireActiveCustomer(userId, input.customerId, db ?? prisma);
  const lineInputs = toLineInputs(input.lines);
  const totals = computeInvoiceTotals(lineInputs);

  const issueDate = isoDateToUtc(input.issueDate);
  await assertPeriodOpen(userId, [issueDate], db ?? prisma);
  let dueDate: Date;
  try {
    dueDate = input.dueDate
      ? isoDateToUtc(input.dueDate)
      : dueDateFor(issueDate, input.paymentTermDays ?? customer.defaultPaymentTermDays);
  } catch (error) {
    if (error instanceof InvoiceValidationError) throw new ValidationError(error.message);
    throw error;
  }
  if (dueDate.getTime() < issueDate.getTime()) {
    throw new ValidationError("Eräpäivä ei voi olla ennen laskun päivää.");
  }

  const prepared = {
    customerId: customer.id,
    issueDate,
    dueDate,
    notes: input.notes?.trim() || null,
    totals,
    lineInputs,
  };

  // The number is consumed inside the same transaction as the insert. A rolled
  // back attempt does not burn it, and two parallel creates cannot take the
  // same integer. The unique index is the backstop. When the caller already
  // owns the transaction, a unique conflict propagates so that caller can retry.
  if (db) {
    const createdId = await insertInvoice(db, userId, prepared);
    return getInvoice(userId, createdId, db);
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const createdId = await prisma.$transaction((tx) => insertInvoice(tx, userId, prepared));
      return getInvoice(userId, createdId);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "P2002") throw error;
    }
  }
  throw new AppError("Laskunumeron varaus epäonnistui, yritä uudelleen.", "NUMBER_RACE", 409);
}

export async function getInvoice(
  userId: string,
  id: string,
  db: InvoiceWriter = prisma
): Promise<PublicInvoice> {
  const invoice = await db.salesInvoice.findFirst({
    where: { id, userId },
    include: invoiceInclude,
  });
  if (!invoice) throw new NotFoundError("Laskua ei löytynyt.");
  return toPublicInvoice(invoice);
}

export interface UpdateInvoiceInput {
  customerId?: string;
  issueDate?: string;
  dueDate?: string;
  notes?: string | null;
  lines?: InvoiceLinePayload[];
  expectedUpdatedAt?: string | null;
}

/**
 * Only a draft may have its content rewritten. Once an invoice is sent the
 * customer holds a copy, so the numbers are frozen; the due date and notes can
 * still move (payment reminders and agreed extensions are normal).
 */
export async function updateInvoice(
  userId: string,
  id: string,
  input: UpdateInvoiceInput
): Promise<PublicInvoice> {
  const existing = await prisma.salesInvoice.findFirst({
    where: { id, userId },
    select: {
      id: true,
      status: true,
      issueDate: true,
      dueDate: true,
      updatedAt: true,
      grossCents: true,
    },
  });
  if (!existing) throw new NotFoundError("Laskua ei löytynyt.");
  const expected = expectedUpdatedAtDate(input.expectedUpdatedAt);

  await assertPeriodOpen(userId, [
    existing.issueDate,
    input.issueDate ? isoDateToUtc(input.issueDate) : null,
  ]);

  const isDraft = existing.status === "draft";
  if (!isDraft && (input.lines || input.customerId || input.issueDate)) {
    throw new AppError(
      "Lähetetyn laskun rivejä, asiakasta tai päivää ei voi muuttaa. Hyvitä lasku ja tee uusi.",
      "INVOICE_LOCKED",
      409
    );
  }

  const data: Prisma.SalesInvoiceUncheckedUpdateManyInput = {};
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
  if (input.customerId) {
    const customer = await requireActiveCustomer(userId, input.customerId);
    data.customerId = customer.id;
  }
  const issueDate = input.issueDate ? isoDateToUtc(input.issueDate) : existing.issueDate;
  if (input.issueDate) data.issueDate = issueDate;
  if (input.dueDate) {
    const dueDate = isoDateToUtc(input.dueDate);
    if (dueDate.getTime() < issueDate.getTime()) {
      throw new ValidationError("Eräpäivä ei voi olla ennen laskun päivää.");
    }
    data.dueDate = dueDate;
  }

  if (input.lines) {
    const lineInputs = toLineInputs(input.lines);
    const totals = computeInvoiceTotals(lineInputs);
    data.netCents = totals.netCents;
    data.vatCents = totals.vatCents;
    data.grossCents = totals.grossCents;

    await prisma.$transaction(async (tx) => {
      await applyInvoiceUpdate(tx, userId, id, expected, data);
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.invoiceLine.createMany({
        data: lineInputs.map((line, index) => ({
          invoiceId: id,
          sortOrder: index,
          description: line.description,
          unit: line.unit,
          quantityMilli: line.quantityMilli,
          unitPriceCents: line.unitPriceCents,
          vatRatePermille: line.vatRatePermille,
          netCents: totals.lines[index].netCents,
        })),
      });
      if (totals.grossCents !== existing.grossCents) {
        await recordActivity(
          tx,
          id,
          "amount_changed",
          `Summa muuttui ${formatEur(centsToEuros(existing.grossCents))} → ${formatEur(centsToEuros(totals.grossCents))}.`
        );
      }
    });
  } else if (Object.keys(data).length > 0) {
    await prisma.$transaction((tx) => applyInvoiceUpdate(tx, userId, id, expected, data));
  }

  return getInvoice(userId, id);
}

async function applyInvoiceUpdate(
  tx: Prisma.TransactionClient,
  userId: string,
  id: string,
  expected: Date | null,
  data: Prisma.SalesInvoiceUncheckedUpdateManyInput
): Promise<void> {
  const updated = await tx.salesInvoice.updateMany({
    where: {
      id,
      userId,
      sendLockToken: null,
      ...(expected ? { updatedAt: expected } : {}),
    },
    data,
  });
  if (updated.count > 0) return;
  const still = await tx.salesInvoice.findFirst({
    where: { id, userId },
    select: { sendLockToken: true },
  });
  if (!still) throw new NotFoundError("Laskua ei löytynyt.");
  if (still.sendLockToken) {
    throw new ConflictError(
      "Laskua lähetetään juuri nyt. Odota hetki ja lataa tiedot uudelleen.",
      "SEND_IN_PROGRESS"
    );
  }
  throw versionConflict();
}

export async function deleteInvoice(userId: string, id: string): Promise<void> {
  const existing = await prisma.salesInvoice.findFirst({
    where: { id, userId },
    select: { id: true, status: true, issueDate: true },
  });
  if (!existing) throw new NotFoundError("Laskua ei löytynyt.");
  await assertPeriodOpen(userId, [existing.issueDate]);
  if (existing.status !== "draft") {
    throw new AppError(
      "Vain luonnoksen voi poistaa. Lähetetty lasku hyvitetään.",
      "INVOICE_LOCKED",
      409
    );
  }
  await prisma.salesInvoice.delete({ where: { id } });
}

/**
 * Issues a numbered credit note that reverses the original lines and marks
 * the original credited. Status alone is not a credit note.
 */
export async function createCreditNote(userId: string, invoiceId: string): Promise<PublicInvoice> {
  const original = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, userId },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  if (!original) throw new NotFoundError("Laskua ei löytynyt.");
  if (original.documentKind === "credit_note") {
    throw new AppError("Hyvityslaskua ei hyvitetä uudelleen.", "CREDIT_NOTE_REQUIRED", 409);
  }
  if (original.status === "draft") {
    throw new AppError("Luonnosta ei hyvitetä. Poista luonnos.", "INVOICE_IS_DRAFT", 409);
  }
  if (original.status === "credited") {
    throw new AppError("Lasku on jo hyvitetty.", "ALREADY_CREDITED", 409);
  }
  const existingNote = await prisma.salesInvoice.findFirst({
    where: { userId, creditsInvoiceId: original.id },
    select: { id: true },
  });
  if (existingNote) {
    throw new AppError("Laskulla on jo hyvityslasku.", "ALREADY_CREDITED", 409);
  }
  if (original.lines.length === 0) {
    throw new ValidationError("Tyhjää laskua ei voi hyvittää.");
  }

  const issueDate = isoDateToUtc(helsinkiCalendarDate());
  await assertPeriodOpen(userId, [issueDate, original.issueDate]);
  const dueDate = issueDate;
  const lineInputs = toLineInputs(
    original.lines.map((line) => ({
      description: line.description,
      quantity: line.quantityMilli / 1000,
      unit: line.unit,
      unitPrice: centsToEuros(-line.unitPriceCents),
      vatRate: line.vatRatePermille / 10,
    }))
  );
  const totals = computeInvoiceTotals(lineInputs);
  const snapshot = await capturePartySnapshot(userId, original.customerId);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const createdId = await prisma.$transaction(async (tx) => {
        const number = await allocateInvoiceNumber(tx, userId);
        const created = await tx.salesInvoice.create({
          data: {
            userId,
            customerId: original.customerId,
            number,
            reference: referenceForInvoice(number),
            issueDate,
            dueDate,
            status: "sent",
            sentAt: new Date(),
            documentKind: "credit_note",
            creditsInvoiceId: original.id,
            partySnapshot: snapshot,
            notes: `Hyvitys laskulle ${original.number}`,
            netCents: totals.netCents,
            vatCents: totals.vatCents,
            grossCents: totals.grossCents,
            lines: {
              create: lineInputs.map((line, index) => ({
                sortOrder: index,
                description: line.description,
                unit: line.unit,
                quantityMilli: line.quantityMilli,
                unitPriceCents: line.unitPriceCents,
                vatRatePermille: line.vatRatePermille,
                netCents: totals.lines[index].netCents,
              })),
            },
          },
          select: { id: true, number: true },
        });
        await tx.salesInvoice.update({
          where: { id: original.id },
          data: { status: "credited" },
        });
        await recordActivity(
          tx,
          created.id,
          "credit_issued",
          `Hyvityslasku luotiin laskulle ${original.number}.`
        );
        await recordActivity(
          tx,
          original.id,
          "credit_issued",
          `Hyvityslasku ${created.number} kirjattiin.`
        );
        await recordActivity(
          tx,
          original.id,
          "status_changed",
          `Tila muuttui: ${statusFi(original.status)} → Hyvitetty.`
        );
        return created.id;
      });
      return getInvoice(userId, createdId);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "P2002") throw error;
    }
  }
  throw new AppError("Laskunumeron varaus epäonnistui, yritä uudelleen.", "NUMBER_RACE", 409);
}

/** Copies lines into a new draft with a new number, dates and status. */
export async function duplicateInvoice(userId: string, invoiceId: string): Promise<PublicInvoice> {
  const source = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, userId },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      customer: { select: { defaultPaymentTermDays: true } },
    },
  });
  if (!source) throw new NotFoundError("Laskua ei löytynyt.");
  if (source.lines.length === 0) throw new ValidationError("Tyhjää laskua ei voi kopioida.");

  const sign = source.documentKind === "credit_note" ? -1 : 1;
  const issueDate = helsinkiCalendarDate();
  const copy = await createInvoice(userId, {
    customerId: source.customerId,
    issueDate,
    paymentTermDays: source.customer.defaultPaymentTermDays,
    notes: source.notes,
    lines: source.lines.map((line) => ({
      description: line.description,
      quantity: line.quantityMilli / 1000,
      unit: line.unit,
      unitPrice: centsToEuros(line.unitPriceCents * sign),
      vatRate: line.vatRatePermille / 10,
    })),
  });
  await prisma.$transaction([
    prisma.invoiceActivity.create({
      data: {
        invoiceId: copy.id,
        kind: "duplicated",
        summary: `Kopioitu laskusta ${source.number}.`,
      },
    }),
    prisma.invoiceActivity.create({
      data: {
        invoiceId: source.id,
        kind: "duplicated",
        summary: `Kopioitu luonnokseksi ${copy.number}.`,
      },
    }),
  ]);
  return getInvoice(userId, copy.id);
}

export async function setInvoiceStatus(
  userId: string,
  id: string,
  target: InvoiceStatus,
  options: { closeReason?: string | null } = {}
): Promise<PublicInvoice> {
  const existing = await prisma.salesInvoice.findFirst({
    where: { id, userId },
    include: { payments: { select: { amountCents: true } }, lines: { select: { id: true } } },
  });
  if (!existing) throw new NotFoundError("Laskua ei löytynyt.");

  await assertPeriodOpen(userId, [existing.issueDate]);

  if (target === "credited") {
    throw new AppError(
      "Hyvitys tehdään erillisellä hyvityslaskulla.",
      "CREDIT_NOTE_REQUIRED",
      409
    );
  }

  const current = existing.status as InvoiceStatus;
  if (!canTransition(current, target)) {
    throw new AppError(
      `Tilasiirtymä ${current} → ${target} ei ole sallittu.`,
      "INVALID_TRANSITION",
      409
    );
  }
  if (target === "sent" && existing.lines.length === 0) {
    throw new ValidationError("Tyhjää laskua ei voi lähettää.");
  }
  if (target === "draft" && existing.payments.length > 0) {
    throw new AppError(
      "Laskulla on maksuja, joten sitä ei voi palauttaa luonnokseksi.",
      "INVOICE_HAS_PAYMENTS",
      409
    );
  }

  const data: Record<string, unknown> = { status: target };
  if (target === "sent") {
    data.sentAt = existing.sentAt ?? new Date();
    data.paidAt = null;
    data.closedReason = null;
    data.closedAt = null;
  }
  if (target === "paid") {
    const paidCents = existing.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
    const reason = options.closeReason?.trim() ?? "";
    const covered = paidCents >= existing.grossCents;
    if (!covered && reason.length < 3) {
      throw new AppError(
        "Laskua ei voi merkitä maksetuksi ilman maksukirjausta tai vähintään kolmen merkin perustelua.",
        "PAID_REQUIRES_SETTLEMENT",
        409
      );
    }
    data.paidAt = new Date();
    if (reason) {
      data.closedReason = reason;
      data.closedAt = new Date();
    }
  }
  if (target === "draft") {
    data.sentAt = null;
    data.paidAt = null;
    data.partySnapshot = null;
    data.closedReason = null;
    data.closedAt = null;
  }
  if (target === "sent" && current === "draft") {
    data.partySnapshot =
      existing.partySnapshot ?? (await capturePartySnapshot(userId, existing.customerId));
  }

  await prisma.$transaction(async (tx) => {
    await tx.salesInvoice.update({ where: { id }, data });
    if (current !== target) {
      await recordActivity(
        tx,
        id,
        "status_changed",
        `Tila muuttui: ${statusFi(current)} → ${statusFi(target)}.`
      );
    }
  });
  return getInvoice(userId, id);
}

export interface RecordPaymentInput {
  amount: number;
  paidDate: string;
  transactionId?: string | null;
  note?: string | null;
  source?: "manual" | "bank";
}

/** Records a payment and closes the invoice once it is fully covered. */
export async function recordPayment(
  userId: string,
  invoiceId: string,
  input: RecordPaymentInput,
  db?: Prisma.TransactionClient
): Promise<PublicInvoice> {
  const conn = db ?? prisma;
  const invoice = await conn.salesInvoice.findFirst({
    where: { id: invoiceId, userId },
    include: { payments: { select: { amountCents: true } } },
  });
  if (!invoice) throw new NotFoundError("Laskua ei löytynyt.");
  if (invoice.status === "draft") {
    throw new AppError("Luonnokselle ei voi kirjata maksua.", "INVOICE_IS_DRAFT", 409);
  }
  if (invoice.status === "credited" || invoice.documentKind === "credit_note") {
    throw new AppError("Hyvitetylle laskulle ei voi kirjata maksua.", "INVOICE_CREDITED", 409);
  }

  await assertPeriodOpen(userId, [isoDateToUtc(input.paidDate)], conn);

  const amountCents = eurosToCents(input.amount);
  if (amountCents === 0) throw new ValidationError("Maksun summa ei voi olla nolla.");

  if (input.transactionId) {
    const transaction = await conn.transaction.findFirst({
      where: { id: input.transactionId, statement: { userId } },
      select: { id: true },
    });
    if (!transaction) throw new NotFoundError("Tapahtumaa ei löytynyt.");
    const taken = await conn.invoicePayment.findUnique({
      where: { transactionId: input.transactionId },
      select: { invoiceId: true },
    });
    if (taken) {
      throw new AppError(
        "Tämä tilitapahtuma on jo kohdistettu laskulle.",
        "TRANSACTION_ALREADY_USED",
        409
      );
    }
  }

  const paidCents =
    invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0) + amountCents;
  const covered = paidCents >= invoice.grossCents;
  const reopens =
    invoice.status === "paid" && !invoice.closedReason?.trim() && paidCents < invoice.grossCents;

  const writePayment = async (tx: Prisma.TransactionClient) => {
    await tx.invoicePayment.create({
      data: {
        invoiceId,
        transactionId: input.transactionId ?? null,
        paidDate: isoDateToUtc(input.paidDate),
        amountCents,
        source: input.source ?? "manual",
        note: input.note?.trim() || null,
      },
    });
    await recordActivity(
      tx,
      invoiceId,
      "payment_added",
      amountCents < 0
        ? `Hyvitys ${formatEur(centsToEuros(amountCents))} kirjattiin.`
        : `Maksu ${formatEur(centsToEuros(amountCents))} kirjattiin.`
    );
    if (covered && invoice.status === "sent") {
      await tx.salesInvoice.update({
        where: { id: invoiceId },
        data: { status: "paid", paidAt: isoDateToUtc(input.paidDate) },
      });
      await recordActivity(tx, invoiceId, "status_changed", "Tila muuttui: Lähetetty → Maksettu.");
    } else if (reopens) {
      await tx.salesInvoice.update({
        where: { id: invoiceId },
        data: { status: "sent", paidAt: null },
      });
      await recordActivity(tx, invoiceId, "status_changed", "Tila muuttui: Maksettu → Lähetetty.");
    }
  };
  if (db) await writePayment(db);
  else await prisma.$transaction(writePayment);

  return getInvoice(userId, invoiceId, conn);
}

export async function removePayment(
  userId: string,
  invoiceId: string,
  paymentId: string
): Promise<PublicInvoice> {
  const invoice = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, userId },
    select: { id: true, status: true, closedReason: true },
  });
  if (!invoice) throw new NotFoundError("Laskua ei löytynyt.");

  const payment = await prisma.invoicePayment.findFirst({
    where: { id: paymentId, invoiceId },
    select: { paidDate: true },
  });
  if (!payment) throw new NotFoundError("Maksua ei löytynyt.");
  await assertPeriodOpen(userId, [payment.paidDate]);

  const removed = await prisma.$transaction(async (tx) => {
    const deleted = await tx.invoicePayment.deleteMany({
      where: { id: paymentId, invoiceId },
    });
    if (deleted.count === 0) return false;
    await recordActivity(tx, invoiceId, "payment_removed", "Maksu poistettiin.");

    // A write-off stays closed. A payment-only close reopens when the cover is gone.
    if (invoice.status === "paid" && !invoice.closedReason?.trim()) {
      const remaining = await tx.invoicePayment.aggregate({
        where: { invoiceId },
        _sum: { amountCents: true },
      });
      const full = await tx.salesInvoice.findUnique({
        where: { id: invoiceId },
        select: { grossCents: true },
      });
      if ((remaining._sum.amountCents ?? 0) < (full?.grossCents ?? 0)) {
        await tx.salesInvoice.update({
          where: { id: invoiceId },
          data: { status: "sent", paidAt: null },
        });
        await recordActivity(tx, invoiceId, "status_changed", "Tila muuttui: Maksettu → Lähetetty.");
      }
    }
    return true;
  });
  if (!removed) throw new NotFoundError("Maksua ei löytynyt.");

  return getInvoice(userId, invoiceId);
}

export interface ListInvoicesOptions {
  status?: InvoiceDisplayStatus | "all";
  customerId?: string;
  month?: string;
  limit?: number;
}

export async function listInvoices(
  userId: string,
  options: ListInvoicesOptions = {},
  now: Date = new Date()
): Promise<{ invoices: PublicInvoice[]; aging: AgingReport & { totalOpen: number; overdue: number } }> {
  const where: Record<string, unknown> = { userId };
  if (options.customerId) where.customerId = options.customerId;
  if (options.month) {
    const [year, month] = options.month.split("-").map(Number);
    where.issueDate = {
      gte: new Date(Date.UTC(year, month - 1, 1)),
      lt: new Date(Date.UTC(year, month, 1)),
    };
  }
  if (options.status === "overdue") {
    // Filter in the database before `take`. A post-query filter would hide an
    // old overdue invoice behind 200 newer ones that are not overdue.
    where.status = "sent";
    where.documentKind = "invoice";
    where.dueDate = { lt: overdueBefore(now) };
  } else if (options.status && options.status !== "all") {
    where.status = options.status;
  }

  const rows = await prisma.salesInvoice.findMany({
    where,
    include: invoiceInclude,
    orderBy: [{ issueDate: "desc" }, { number: "desc" }],
    take: options.limit ?? 200,
  });

  const invoices = rows.map((row) => toPublicInvoice(row, now));

  const allOpen = await prisma.salesInvoice.findMany({
    where: { userId, status: { in: ["sent", "paid"] }, documentKind: "invoice" },
    select: {
      status: true,
      dueDate: true,
      grossCents: true,
      closedReason: true,
      payments: { select: { amountCents: true } },
    },
  });
  const aging = buildAgingReport(
    allOpen.map((invoice) => ({
      status: invoice.status as InvoiceStatus,
      dueDate: invoice.dueDate,
      grossCents: invoice.grossCents,
      paidCents: invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0),
      closedReason: invoice.closedReason,
    })),
    now
  );

  return {
    invoices,
    aging: {
      ...aging,
      totalOpen: centsToEuros(aging.totalOpenCents),
      overdue: centsToEuros(aging.overdueCents),
    },
  };
}

export interface BankMatchResult {
  applied: Array<{ invoiceId: string; invoiceNumber: number; transactionId: string; amount: number }>;
  /** Reference hits that fall inside a closed period and were left alone. */
  skippedLocked: Array<{ invoiceId: string; invoiceNumber: number; transactionId: string }>;
  suggestions: Array<{
    invoiceId: string;
    invoiceNumber: number;
    transactionId: string;
    amount: number;
    reason: "amount_and_date";
  }>;
}

/**
 * Matches incoming bank rows against open invoices.
 *
 * A reference (viitenumero) hit is applied automatically - that is exactly what
 * the reference exists for. Anything weaker is only suggested, because posting
 * a payment on a guess would corrupt the books.
 */
export async function matchInvoicePaymentsFromBank(
  userId: string,
  now: Date = new Date()
): Promise<BankMatchResult> {
  const openInvoices = await prisma.salesInvoice.findMany({
    where: { userId, status: "sent", documentKind: "invoice" },
    include: { payments: { select: { amountCents: true } } },
  });
  if (openInvoices.length === 0) return { applied: [], suggestions: [], skippedLocked: [] };

  const incoming = await prisma.transaction.findMany({
    where: {
      statement: { userId },
      amountCents: { gt: 0 },
      invoicePayment: null,
    },
    select: { id: true, amountCents: true, date: true, reference: true, message: true },
  });

  const byReference = new Map(openInvoices.map((invoice) => [invoice.reference, invoice]));
  const applied: BankMatchResult["applied"] = [];
  const suggestions: BankMatchResult["suggestions"] = [];
  const skippedLocked: BankMatchResult["skippedLocked"] = [];
  const consumed = new Set<string>();

  for (const transaction of incoming) {
    const candidates = [transaction.reference, transaction.message]
      .filter((value): value is string => Boolean(value))
      .map(normalizeReference);

    const invoice = candidates.map((value) => byReference.get(value)).find(Boolean);
    if (!invoice) continue;

    try {
      await recordPayment(userId, invoice.id, {
        amount: centsToEuros(transaction.amountCents),
        paidDate: (transaction.date ?? now).toISOString().slice(0, 10),
        transactionId: transaction.id,
        source: "bank",
        note: "Kohdistettu viitenumerolla",
      });
    } catch (error) {
      // A closed period stops this one payment, not the whole run.
      if (error instanceof PeriodLockedError) {
        skippedLocked.push({
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          transactionId: transaction.id,
        });
        consumed.add(transaction.id);
        continue;
      }
      throw error;
    }
    applied.push({
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      transactionId: transaction.id,
      amount: centsToEuros(transaction.amountCents),
    });
    consumed.add(transaction.id);
    byReference.delete(invoice.reference);
  }

  // Weaker signal: exact open amount, paid on or after the invoice was issued.
  for (const transaction of incoming) {
    if (consumed.has(transaction.id)) continue;
    for (const invoice of openInvoices) {
      if (applied.some((entry) => entry.invoiceId === invoice.id)) continue;
      const paid = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
      const open = invoice.grossCents - paid;
      if (open <= 0 || transaction.amountCents !== open) continue;
      if (transaction.date && transaction.date.getTime() < invoice.issueDate.getTime()) continue;
      suggestions.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        transactionId: transaction.id,
        amount: centsToEuros(transaction.amountCents),
        reason: "amount_and_date",
      });
      break;
    }
  }

  return { applied, suggestions, skippedLocked };
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

/** Seller and customer as they should be printed, serialised for storage. */
export async function capturePartySnapshot(userId: string, customerId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("Käyttäjää ei löytynyt.");
  const customer = await prisma.customer.findFirst({ where: { id: customerId, userId } });
  if (!customer) throw new NotFoundError("Asiakasta ei löytynyt.");
  return serializePartySnapshot(sellerFromUser(user), customerFromCustomer(customer));
}

/**
 * Assembles everything the PDF needs. A draft reads the live profile. An
 * issued invoice is regenerated only from the snapshot taken when it left draft.
 */
export async function buildInvoicePdfData(
  userId: string,
  invoiceId: string
): Promise<InvoicePdfData> {
  const invoice = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, userId },
    include: {
      customer: true,
      lines: { orderBy: { sortOrder: "asc" } },
      creditsInvoice: { select: { number: true } },
    },
  });
  if (!invoice) throw new NotFoundError("Laskua ei löytynyt.");

  let parties = parsePartySnapshot(invoice.partySnapshot);
  if (!parties && invoice.status !== "draft") {
    const raw = await capturePartySnapshot(userId, invoice.customerId);
    await prisma.salesInvoice.update({
      where: { id: invoice.id },
      data: { partySnapshot: raw },
    });
    parties = parsePartySnapshot(raw);
  }
  if (!parties) {
    const accepted = await prisma.invoiceEmailSend.findFirst({
      where: {
        invoiceId: invoice.id,
        status: { in: ["pending", "sent"] },
        partySnapshot: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { partySnapshot: true },
    });
    parties = parsePartySnapshot(accepted?.partySnapshot);
  }

  let seller = parties?.seller;
  let customer = parties?.customer;
  if (!seller || !customer) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError("Käyttäjää ei löytynyt.");
    seller = sellerFromUser(user);
    customer = customerFromCustomer(invoice.customer);
  }

  const totals = computeInvoiceTotals(
    invoice.lines.map((line) => ({
      quantityMilli: line.quantityMilli,
      unitPriceCents: line.unitPriceCents,
      vatRatePermille: line.vatRatePermille,
    }))
  );

  return {
    number: invoice.number,
    documentKind: invoice.documentKind === "credit_note" ? "credit_note" : "invoice",
    originalNumber: invoice.creditsInvoice?.number ?? null,
    reference: invoice.reference,
    issueDate: invoice.issueDate.toISOString().slice(0, 10),
    dueDate: invoice.dueDate.toISOString().slice(0, 10),
    notes: invoice.notes,
    netCents: invoice.netCents,
    vatCents: invoice.vatCents,
    grossCents: invoice.grossCents,
    breakdown: totals.breakdown,
    seller,
    customer,
    lines: invoice.lines.map((line) => ({
      description: line.description,
      quantityMilli: line.quantityMilli,
      unit: line.unit,
      unitPriceCents: line.unitPriceCents,
      vatRatePermille: line.vatRatePermille,
      netCents: line.netCents,
    })),
  };
}

/** Filename used for downloads and email attachments. */
export function invoicePdfFileName(
  number: number,
  documentKind: "invoice" | "credit_note" = "invoice"
): string {
  const prefix = documentKind === "credit_note" ? "hyvitys" : "lasku";
  return `${prefix}-${String(number).padStart(4, "0")}.pdf`;
}
