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
import { formatDate, formatEur } from "./format";
import { allocateInvoiceNumber, peekInvoiceNumber } from "./invoice-sequence";
import { helsinkiCalendarDate, isoDateToUtc, periodScopeBoundsUtc } from "./validation";
import { normalizeReference, referenceForInvoice } from "./finnish-reference";
import {
  adjustVatRateForDate,
  applySellerVatRules,
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
import { assertPeriodOpen, getLockedThrough, isDateLocked, PeriodLockedError } from "./period-lock";
import { INVOICE_LIST_LIMIT } from "./invoice-groups";
import { DUPLICATE_DATE_WINDOW_DAYS, DUPLICATE_DISMISSED_KIND } from "./alv-period";
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
 * The VAT a seller's lines may carry on `issueDate` (F01, F44): 0 % on every
 * line when the seller is not VAT registered, and for a registered seller only
 * the rates valid that day. Every path that writes new lines goes through
 * here, so the form is a convenience and the server is the authority. A credit
 * note does not: it reverses the original as it was charged.
 */
export async function applyVatRules<T extends { vatRatePermille: number }>(
  userId: string,
  lines: T[],
  issueDate: string,
  db: InvoiceWriter = prisma
): Promise<T[]> {
  const seller = await db.user.findUnique({
    where: { id: userId },
    select: { vatRegistered: true },
  });
  if (!seller) throw new NotFoundError("Käyttäjää ei löytynyt.");
  try {
    return applySellerVatRules(lines, { vatRegistered: seller.vatRegistered, issueDate });
  } catch (error) {
    if (error instanceof InvoiceValidationError) throw new ValidationError(error.message);
    throw error;
  }
}

/**
 * A draft keeps the VAT it was saved with. If the seller's VAT status changed
 * after that (corrected to "not VAT registered", or a rate that has ended), the
 * stored lines no longer follow the rule. Sending must not bill them, and must
 * not quietly change a document total either: it refuses and says what to do.
 * Opening the draft and saving it applies the rule (see applyVatRules).
 */
export async function assertDraftVatCurrent(userId: string, invoiceId: string): Promise<void> {
  const invoice = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, userId },
    select: { documentKind: true, issueDate: true, lines: { select: { vatRatePermille: true } } },
  });
  if (!invoice || invoice.documentKind === "credit_note") return;
  const seller = await prisma.user.findUnique({ where: { id: userId }, select: { vatRegistered: true } });
  if (!seller) return;
  let current = true;
  try {
    const checked = applySellerVatRules(invoice.lines, {
      vatRegistered: seller.vatRegistered,
      issueDate: invoice.issueDate.toISOString().slice(0, 10),
    });
    current = checked.every((line, index) => line.vatRatePermille === invoice.lines[index].vatRatePermille);
  } catch (error) {
    if (!(error instanceof InvoiceValidationError)) throw error;
    current = false;
  }
  if (!current) {
    throw new AppError(
      "Luonnoksen ALV ei vastaa yrityksen nykyisiä tietoja. Avaa luonnos ja tallenna se, niin ALV päivittyy. Sen jälkeen lasku voidaan lähettää.",
      "DRAFT_VAT_OUTDATED",
      409
    );
  }
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
  const lineInputs = await applyVatRules(
    userId,
    toLineInputs(input.lines),
    input.issueDate,
    db ?? prisma
  );
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

  const issueDateIso = issueDate.toISOString().slice(0, 10);
  if (input.issueDate && !input.lines) {
    // The lines stay as they are, so they must still be valid on the new date
    // (a 14 % line cannot ride a draft into 2026).
    const stored = await prisma.invoiceLine.findMany({
      where: { invoiceId: id },
      select: { vatRatePermille: true },
    });
    await applyVatRules(userId, stored, issueDateIso);
  }

  if (input.lines) {
    const lineInputs = await applyVatRules(userId, toLineInputs(input.lines), issueDateIso);
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

/**
 * A send that has held its lock this long belongs to a process that died (the
 * mail server's own timeouts are shorter). Past this age neither an edit nor a
 * new send is held back by it.
 */
export const SEND_ATTEMPT_STALE_MS = 10 * 60 * 1000;

async function applyInvoiceUpdate(
  tx: Prisma.TransactionClient,
  userId: string,
  id: string,
  expected: Date | null,
  data: Prisma.SalesInvoiceUncheckedUpdateManyInput
): Promise<void> {
  // A mail the server accepted but whose outcome was not stored leaves its lock
  // behind on purpose. The customer holds that PDF, so the draft is not changed
  // under it, however old the lock is (the send guard never lets it go either).
  const unrecorded = await tx.invoiceEmailSend.findFirst({
    where: { invoiceId: id, status: "ambiguous", invoice: { userId, sendLockToken: { not: null } } },
    select: { id: true },
  });
  if (unrecorded) {
    throw new ConflictError(
      "Edellinen lähetys jäi epäselväksi, joten laskua ei voi muokata. Älä lähetä samaa laskua uudelleen ennen tarkistusta.",
      "SEND_AMBIGUOUS"
    );
  }

  const staleBefore = new Date(Date.now() - SEND_ATTEMPT_STALE_MS);
  const updated = await tx.salesInvoice.updateMany({
    where: {
      id,
      userId,
      OR: [{ sendLockToken: null }, { sendLockAt: { lt: staleBefore } }],
      ...(expected ? { updatedAt: expected } : {}),
    },
    data,
  });
  if (updated.count > 0) return;
  const still = await tx.salesInvoice.findFirst({
    where: { id, userId },
    select: { sendLockToken: true, sendLockAt: true },
  });
  if (!still) throw new NotFoundError("Laskua ei löytynyt.");
  if (still.sendLockToken && !(still.sendLockAt && still.sendLockAt < staleBefore)) {
    throw new ConflictError(
      "Laskua lähetetään juuri nyt. Odota hetki ja lataa tiedot uudelleen.",
      "SEND_IN_PROGRESS"
    );
  }
  throw versionConflict();
}

/**
 * A credit note is a numbered document the customer already holds, counted in
 * the VAT month it was issued. It never goes back to draft, never changes
 * status and is never deleted; a mistake is corrected with a new invoice.
 */
function assertNotCreditNote(documentKind: string): void {
  if (documentKind === "credit_note") {
    throw new AppError(
      "Hyvityslaskua ei voi muuttaa eikä poistaa. Korjaa tarvittaessa uudella laskulla.",
      "CREDIT_NOTE_IMMUTABLE",
      409
    );
  }
}

export async function deleteInvoice(userId: string, id: string): Promise<void> {
  const existing = await prisma.salesInvoice.findFirst({
    where: { id, userId },
    select: { id: true, status: true, issueDate: true, documentKind: true },
  });
  if (!existing) throw new NotFoundError("Laskua ei löytynyt.");
  assertNotCreditNote(existing.documentKind);
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
  // Only the credit note's own month changes (AVL 136 §): the original stays
  // counted where it was, and its status flag moves no report. So a filed,
  // locked month can still be corrected by crediting in an open one.
  await assertPeriodOpen(userId, [issueDate]);
  const dueDate = issueDate;
  // Deliberately not through applyVatRules: a credit note reverses what the
  // original charged, rate for rate, even when the seller is no longer VAT
  // registered or the rate has since ended (a 14 % invoice from 2025 is
  // credited at 14 %). Anything else would leave VAT on the customer's account.
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
      // A copy is a new invoice dated today: an ended 14 % becomes 13,5 %, and
      // createInvoice forces 0 % for a seller who is not VAT registered.
      vatRate: adjustVatRateForDate(line.vatRatePermille, issueDate) / 10,
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
  assertNotCreditNote(existing.documentKind);

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
  if (target === "sent" && current === "draft") {
    await assertDraftVatCurrent(userId, id);
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

/**
 * Records a payment and closes the invoice once it is fully covered.
 *
 * A payment keyed in by hand is checked against what the invoice still owes:
 * it must be positive, not dated before the invoice or in the future, and not
 * larger than the open balance. The balance is read in the same transaction as
 * the insert, after a write has taken SQLite's write lock, so two payments that
 * arrive together (two devices, two idempotency keys) cannot both fit. A
 * payment that carries a bank row (`transactionId`, or `source: "bank"`) records
 * what the bank says happened and is not refused on amount or date, whichever
 * way it arrives (reference match, Koti, the invoice page).
 */
export async function recordPayment(
  userId: string,
  invoiceId: string,
  input: RecordPaymentInput,
  db?: Prisma.TransactionClient
): Promise<PublicInvoice> {
  const source = input.transactionId ? "bank" : (input.source ?? "manual");
  const manual = source === "manual";
  const amountCents = eurosToCents(input.amount);
  if (amountCents === 0 || (manual && amountCents < 0)) {
    throw new ValidationError("Maksun summan pitää olla suurempi kuin nolla.");
  }
  if (manual && input.paidDate > helsinkiCalendarDate()) {
    throw new AppError(
      "Maksupäivä ei voi olla tulevaisuudessa.",
      "PAYMENT_IN_FUTURE",
      422
    );
  }

  const run = async (conn: Prisma.TransactionClient) => {
    // A write comes first: it takes the write lock, so the balance read below
    // is still true when this transaction commits.
    await conn.$executeRaw`UPDATE "SalesInvoice" SET "grossCents" = "grossCents" WHERE "id" = ${invoiceId} AND "userId" = ${userId}`;

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

    if (manual && isoDateToUtc(input.paidDate) < invoice.issueDate) {
      throw new AppError(
        `Maksupäivä (${formatDate(input.paidDate)}) on ennen laskun päivää (${formatDate(invoice.issueDate.toISOString())}).`,
        "PAYMENT_BEFORE_INVOICE",
        422
      );
    }

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

    const paidBefore = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
    const openCents = invoice.grossCents - paidBefore;
    if (manual && amountCents > openCents) {
      throw new AppError(
        openCents <= 0
          ? `Lasku on jo maksettu. Avoin summa on ${formatEur(0)}.`
          : `Maksu on suurempi kuin laskun avoin summa (${formatEur(centsToEuros(openCents))}). Kirjaa enintään avoin summa.`,
        "PAYMENT_EXCEEDS_OPEN",
        422,
        { openCents }
      );
    }

    const paidCents = paidBefore + amountCents;
    const covered = paidCents >= invoice.grossCents;
    const reopens =
      invoice.status === "paid" && !invoice.closedReason?.trim() && paidCents < invoice.grossCents;

    await conn.invoicePayment.create({
      data: {
        invoiceId,
        transactionId: input.transactionId ?? null,
        paidDate: isoDateToUtc(input.paidDate),
        amountCents,
        source,
        note: input.note?.trim() || null,
      },
    });
    await recordActivity(
      conn,
      invoiceId,
      "payment_added",
      amountCents < 0
        ? `Hyvitys ${formatEur(centsToEuros(amountCents))} kirjattiin.`
        : `Maksu ${formatEur(centsToEuros(amountCents))} kirjattiin.`
    );
    if (covered && invoice.status === "sent") {
      await conn.salesInvoice.update({
        where: { id: invoiceId },
        data: { status: "paid", paidAt: isoDateToUtc(input.paidDate) },
      });
      await recordActivity(conn, invoiceId, "status_changed", "Tila muuttui: Lähetetty → Maksettu.");
    } else if (reopens) {
      await conn.salesInvoice.update({
        where: { id: invoiceId },
        data: { status: "sent", paidAt: null },
      });
      await recordActivity(conn, invoiceId, "status_changed", "Tila muuttui: Maksettu → Lähetetty.");
    }
  };
  if (db) await run(db);
  else await prisma.$transaction(run);

  return getInvoice(userId, invoiceId, db ?? prisma);
}

export interface BankRowCandidate {
  transactionId: string;
  date: string | null;
  counterparty: string | null;
  amount: number;
  /** An income receipt was already drafted from this row. */
  hasReceipt: boolean;
}

/**
 * Incoming bank rows a hand-recorded payment most likely is: same amount, a
 * date within a few days, and not yet settling any invoice. Offered when the
 * payment is recorded, so the payment carries the row and the income receipt
 * drafted from the same row is never counted on top of the invoice.
 */
export async function findBankRowsForPayment(
  userId: string,
  amountCents: number,
  paidDate: string
): Promise<BankRowCandidate[]> {
  if (amountCents <= 0) return [];
  const day = isoDateToUtc(paidDate).getTime();
  const windowMs = DUPLICATE_DATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const rows = await prisma.transaction.findMany({
    where: {
      statement: { userId },
      type: "tulo",
      amountCents,
      invoicePayment: null,
      purchasePayment: null,
      date: { gte: new Date(day - windowMs), lte: new Date(day + windowMs) },
    },
    select: { id: true, date: true, counterparty: true, amountCents: true, receiptId: true },
    orderBy: { date: "asc" },
    take: 5,
  });
  const drafted = await prisma.receipt.findMany({
    where: { userId, sourceTransactionId: { in: rows.map((row) => row.id) } },
    select: { sourceTransactionId: true },
  });
  const draftedIds = new Set(drafted.map((receipt) => receipt.sourceTransactionId));
  return rows
    .map((row) => ({
      transactionId: row.id,
      date: row.date ? row.date.toISOString().slice(0, 10) : null,
      counterparty: row.counterparty,
      amount: centsToEuros(row.amountCents),
      hasReceipt: row.receiptId !== null || draftedIds.has(row.id),
    }))
    .sort((a, b) => {
      const gap = (value: string | null) =>
        value ? Math.abs(isoDateToUtc(value).getTime() - day) : Number.MAX_SAFE_INTEGER;
      return gap(a.date) - gap(b.date);
    });
}

/**
 * Attaches a bank row to a payment that was recorded by hand. The row then
 * proves the payment, and an income receipt from the same row stops counting
 * as separate income. Refused when the amounts differ or the row is taken.
 */
export async function linkPaymentToTransaction(
  userId: string,
  invoiceId: string,
  paymentId: string,
  transactionId: string
): Promise<PublicInvoice> {
  const payment = await prisma.invoicePayment.findFirst({
    where: { id: paymentId, invoiceId, invoice: { userId } },
    select: { id: true, transactionId: true, amountCents: true, paidDate: true },
  });
  if (!payment) throw new NotFoundError("Maksua ei löytynyt.");
  if (payment.transactionId) {
    throw new AppError("Maksu on jo yhdistetty tilitapahtumaan.", "PAYMENT_ALREADY_LINKED", 409);
  }
  const row = await prisma.transaction.findFirst({
    where: { id: transactionId, statement: { userId } },
    select: {
      id: true,
      date: true,
      type: true,
      amountCents: true,
      invoicePayment: { select: { id: true } },
      receipt: { select: { date: true } },
    },
  });
  if (!row) throw new NotFoundError("Tapahtumaa ei löytynyt.");
  if (row.invoicePayment) {
    throw new AppError(
      "Tämä tilitapahtuma on jo kohdistettu laskulle.",
      "TRANSACTION_ALREADY_USED",
      409
    );
  }
  if (row.type !== "tulo" || row.amountCents !== payment.amountCents) {
    throw new ValidationError("Tilitapahtuman summa ei vastaa maksua.");
  }
  // Linking drops the income receipt of this row from its month, so that
  // month must still be open, like the payment's own.
  const drafted = await prisma.receipt.findMany({
    where: { userId, sourceTransactionId: row.id },
    select: { date: true },
  });
  await assertPeriodOpen(userId, [
    payment.paidDate,
    row.date,
    row.receipt?.date,
    ...drafted.map((receipt) => receipt.date),
  ]);

  await prisma.$transaction(async (tx) => {
    const updated = await tx.invoicePayment.updateMany({
      where: { id: payment.id, transactionId: null },
      data: { transactionId: row.id, source: "bank" },
    });
    if (updated.count === 0) {
      throw new AppError("Maksu on jo yhdistetty tilitapahtumaan.", "PAYMENT_ALREADY_LINKED", 409);
    }
    await recordActivity(tx, invoiceId, "payment_linked", "Maksu yhdistettiin tilitapahtumaan.");
  });
  return getInvoice(userId, invoiceId);
}

/** The user says a flagged receipt and payment are two separate incomes. */
export async function dismissPaymentDuplicate(
  userId: string,
  invoiceId: string,
  paymentId: string,
  receiptId: string
): Promise<void> {
  const [payment, receipt] = await Promise.all([
    prisma.invoicePayment.findFirst({
      where: { id: paymentId, invoiceId, invoice: { userId } },
      select: { id: true },
    }),
    prisma.receipt.findFirst({ where: { id: receiptId, userId }, select: { id: true } }),
  ]);
  if (!payment || !receipt) throw new NotFoundError("Maksua tai kuittia ei löytynyt.");
  await prisma.automationEvent.create({
    data: {
      userId,
      kind: DUPLICATE_DISMISSED_KIND,
      resourceType: "receipt",
      resourceId: receipt.id,
      newValue: payment.id,
      reason: "Käyttäjä vahvisti kuitin ja laskun maksun erillisiksi tuloiksi.",
    },
  });
  await recordActivity(
    prisma,
    invoiceId,
    "payment_duplicate_dismissed",
    "Maksu ja tulokuitti merkittiin erillisiksi tuloiksi."
  );
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
    select: { paidDate: true, transactionId: true },
  });
  if (!payment) throw new NotFoundError("Maksua ei löytynyt.");

  // While a bank row settles the invoice, an income receipt of that same row is
  // left out of the books (the invoice is the sale). Once the payment is gone
  // the row settles nothing and the receipt would be counted next to the
  // invoice. It goes back to waiting for approval, as when the link of a sale
  // is undone, so the sale is counted once at every step.
  const sameMoney = payment.transactionId
    ? await prisma.receipt.findMany({
        where: {
          userId,
          type: "tulo",
          reviewStatus: "approved",
          OR: [
            { sourceTransactionId: payment.transactionId },
            { linkedTransaction: { is: { id: payment.transactionId } } },
          ],
        },
        select: { id: true, date: true },
      })
    : [];
  await assertPeriodOpen(userId, [payment.paidDate, ...sameMoney.map((receipt) => receipt.date)]);

  const removed = await prisma.$transaction(async (tx) => {
    const deleted = await tx.invoicePayment.deleteMany({
      where: { id: paymentId, invoiceId },
    });
    if (deleted.count === 0) return false;
    await recordActivity(tx, invoiceId, "payment_removed", "Maksu poistettiin.");

    if (payment.transactionId && sameMoney.length > 0) {
      await tx.receipt.updateMany({
        where: { id: { in: sameMoney.map((receipt) => receipt.id) }, userId, reviewStatus: "approved" },
        data: { reviewStatus: "pending" },
      });
      await tx.transaction.updateMany({
        where: { id: payment.transactionId, receiptId: { in: sameMoney.map((receipt) => receipt.id) } },
        data: {
          receiptId: null,
          matchStatus: "unmatched",
          suggestedReceiptId: null,
          matchScore: null,
          matchReasons: null,
        },
      });
    }

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
  /** Customer name, invoice number or reference (SALES-10). */
  search?: string;
  limit?: number;
}

/** Search across customer name, invoice number and reference. */
function invoiceSearchWhere(search: string): Record<string, unknown> | null {
  const text = search.trim().slice(0, 80);
  if (!text) return null;
  const or: Array<Record<string, unknown>> = [{ customer: { name: { contains: text } } }];
  const digits = text.replace(/\s+/g, "");
  if (/^\d{1,9}$/.test(digits)) {
    or.push({ number: Number(digits) });
    or.push({ reference: { contains: digits } });
  }
  return { OR: or };
}

/** Shared customerId/month scoping for the list, count, and aging queries. */
function invoiceScopeWhere(
  userId: string,
  options: { customerId?: string; month?: string }
): Record<string, unknown> {
  const where: Record<string, unknown> = { userId };
  if (options.customerId) where.customerId = options.customerId;
  if (options.month) {
    // A month (YYYY-MM) or a whole year (YYYY), from a yearly report figure.
    const bounds = periodScopeBoundsUtc(options.month);
    where.issueDate = { gte: bounds.start, lt: bounds.end };
  }
  return where;
}

/**
 * The exact rows that count as "overdue": a sent invoice that is not a
 * credit note (see `displayStatus` in ./invoices - a credit note always
 * reports its own raw status and is never reclassified as overdue) whose due
 * date has fully passed. Shared by `listInvoices` and
 * `countInvoicesByDisplayStatus` so the two definitions cannot drift apart.
 */
function overdueStatusWhere(now: Date): Record<string, unknown> {
  return { status: "sent", documentKind: "invoice", dueDate: { lt: overdueBefore(now) } };
}

export async function listInvoices(
  userId: string,
  options: ListInvoicesOptions = {},
  now: Date = new Date()
): Promise<{ invoices: PublicInvoice[]; aging: AgingReport & { totalOpen: number; overdue: number } }> {
  const where = invoiceScopeWhere(userId, options);
  const and: Array<Record<string, unknown>> = [];
  if (options.status === "overdue") {
    // Filter in the database before `take`. A post-query filter would hide an
    // old overdue invoice behind INVOICE_LIST_LIMIT newer ones that are not overdue.
    Object.assign(where, overdueStatusWhere(now));
  } else if (options.status === "credited") {
    // A credit note belongs with the invoices it corrects, never under
    // "Avoimet" with a negative amount (SALES-13, SALES-24).
    and.push({ OR: [{ status: "credited" }, { documentKind: "credit_note" }] });
  } else if (options.status === "sent") {
    where.status = "sent";
    where.documentKind = "invoice";
  } else if (options.status && options.status !== "all") {
    where.status = options.status;
  }
  const search = options.search ? invoiceSearchWhere(options.search) : null;
  if (search) and.push(search);
  if (and.length > 0) where.AND = and;

  const rows = await prisma.salesInvoice.findMany({
    where,
    include: invoiceInclude,
    orderBy: [{ issueDate: "desc" }, { number: "desc" }],
    take: options.limit ?? INVOICE_LIST_LIMIT,
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

export interface InvoiceStatusCounts {
  draft: number;
  sent: number;
  overdue: number;
  paid: number;
  credited: number;
}

/**
 * DB-side counts per display status, for the sales list's filter chips.
 * `listInvoices` caps its rows at `INVOICE_LIST_LIMIT`, so counting the
 * fetched rows themselves would silently undercount past that cap - this
 * counts the whole table instead, with the same customerId/month scoping
 * `listInvoices` uses and the same displayStatus semantics as
 * `displayStatus` in ./invoices: a credit note reports its own raw status
 * and is never overdue; a sent invoice is overdue only once its due date has
 * fully passed (see `overdueStatusWhere`, shared with `listInvoices`).
 */
export async function countInvoicesByDisplayStatus(
  userId: string,
  options: { customerId?: string; month?: string } = {},
  now: Date = new Date()
): Promise<InvoiceStatusCounts> {
  const where = invoiceScopeWhere(userId, options);
  const overdueWhere = overdueStatusWhere(now);

  const [draft, sent, overdue, paid, credited] = await Promise.all([
    prisma.salesInvoice.count({ where: { ...where, status: "draft" } }),
    prisma.salesInvoice.count({
      where: {
        ...where,
        status: "sent",
        // Not overdue, and not a credit note: a credit note is counted with
        // the credited invoices it belongs to (SALES-24), never as open.
        documentKind: "invoice",
        dueDate: { gte: overdueBefore(now) },
      },
    }),
    prisma.salesInvoice.count({ where: { ...where, ...overdueWhere } }),
    prisma.salesInvoice.count({ where: { ...where, status: "paid", documentKind: "invoice" } }),
    prisma.salesInvoice.count({
      where: { ...where, OR: [{ status: "credited" }, { documentKind: "credit_note" }] },
    }),
  ]);

  return { draft, sent, overdue, paid, credited };
}

export interface BankMatchResult {
  applied: Array<{ invoiceId: string; invoiceNumber: number; transactionId: string; amount: number }>;
  /** Reference hits that fall inside a closed period and were left alone. */
  skippedLocked: Array<{ invoiceId: string; invoiceNumber: number; transactionId: string }>;
  suggestions: Array<{
    invoiceId: string;
    invoiceNumber: number;
    customerName: string;
    transactionId: string;
    amount: number;
    /** The bank row's booking date, the payment date a confirm would book. */
    paidDate: string;
    reason: "amount_and_date";
  }>;
}

/** A reference hit the run would book, as the confirmation sheet lists it. */
export interface BankMatchPreviewEntry {
  invoiceId: string;
  invoiceNumber: number;
  customerName: string;
  transactionId: string;
  amount: number;
  paidDate: string;
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
  now: Date = new Date(),
  options: { dryRun?: boolean } = {}
): Promise<BankMatchResult & { preview?: BankMatchPreviewEntry[] }> {
  const openInvoices = await prisma.salesInvoice.findMany({
    where: { userId, status: "sent", documentKind: "invoice" },
    include: {
      payments: { select: { amountCents: true } },
      customer: { select: { name: true } },
    },
  });
  if (openInvoices.length === 0) {
    return { applied: [], suggestions: [], skippedLocked: [], ...(options.dryRun ? { preview: [] } : {}) };
  }
  // What a run would book, for the confirmation sheet (SALES-06).
  const preview: BankMatchPreviewEntry[] = [];

  const incoming = await prisma.transaction.findMany({
    where: {
      statement: { userId },
      amountCents: { gt: 0 },
      invoicePayment: null,
    },
    select: { id: true, amountCents: true, date: true, reference: true, message: true },
  });
  // A closed period is left alone by the run, so the preview must say the same
  // thing the run will do, and a suggestion there could never be confirmed.
  const lockedThrough = await getLockedThrough(userId);
  const paidDateOf = (transaction: { date: Date | null }) =>
    (transaction.date ?? now).toISOString().slice(0, 10);

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

    if (options.dryRun && isDateLocked(lockedThrough, paidDateOf(transaction))) {
      skippedLocked.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        transactionId: transaction.id,
      });
      consumed.add(transaction.id);
      continue;
    }

    if (options.dryRun) {
      preview.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        customerName: invoice.customer.name,
        transactionId: transaction.id,
        amount: centsToEuros(transaction.amountCents),
        paidDate: paidDateOf(transaction),
      });
      applied.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        transactionId: transaction.id,
        amount: centsToEuros(transaction.amountCents),
      });
      consumed.add(transaction.id);
      byReference.delete(invoice.reference);
      continue;
    }

    try {
      await recordPayment(userId, invoice.id, {
        amount: centsToEuros(transaction.amountCents),
        paidDate: paidDateOf(transaction),
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
    if (isDateLocked(lockedThrough, paidDateOf(transaction))) continue;
    for (const invoice of openInvoices) {
      if (applied.some((entry) => entry.invoiceId === invoice.id)) continue;
      const paid = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
      const open = invoice.grossCents - paid;
      if (open <= 0 || transaction.amountCents !== open) continue;
      if (transaction.date && transaction.date.getTime() < invoice.issueDate.getTime()) continue;
      suggestions.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        customerName: invoice.customer.name,
        transactionId: transaction.id,
        amount: centsToEuros(transaction.amountCents),
        paidDate: paidDateOf(transaction),
        reason: "amount_and_date",
      });
      break;
    }
  }

  if (options.dryRun) return { applied: [], suggestions, skippedLocked, preview };
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
