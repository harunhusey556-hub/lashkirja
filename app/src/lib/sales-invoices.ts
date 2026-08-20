/**
 * Sales invoices: numbering, totals, lifecycle and bank reconciliation.
 *
 * Arithmetic lives in ./invoices (pure). This module owns persistence and the
 * rules that need the database: the per-user invoice number sequence, which
 * edits a non-draft invoice still allows, and how a bank row becomes a payment.
 */
import { prisma } from "./db";
import { AppError, NotFoundError, ValidationError } from "./api-errors";
import { centsToEuros, eurosToCents } from "./money";
import { isoDateToUtc } from "./validation";
import { normalizeReference, referenceForInvoice } from "./finnish-reference";
import {
  buildAgingReport,
  canTransition,
  computeInvoiceTotals as computeTotalsUnsafe,
  InvoiceValidationError,
  DEFAULT_PAYMENT_TERM_DAYS,
  displayStatus,
  dueDateFor,
  type AgingReport,
  type InvoiceDisplayStatus,
  type InvoiceLineInput,
  type InvoiceStatus,
} from "./invoices";
import { requireActiveCustomer } from "./customers";
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
 * Next number in the user's own sequence. The unique index on (userId, number)
 * is the real guard; this only proposes the value.
 */
export async function nextInvoiceNumber(userId: string): Promise<number> {
  const latest = await prisma.salesInvoice.findFirst({
    where: { userId },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  return (latest?.number ?? 0) + 1;
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
};

const invoiceInclude = {
  customer: { select: { id: true, name: true, email: true, businessId: true } },
  lines: { orderBy: { sortOrder: "asc" as const } },
  payments: { orderBy: { paidDate: "asc" as const } },
};

export function toPublicInvoice(
  invoice: InvoiceWithRelations,
  now: Date = new Date()
): PublicInvoice {
  const paidCents = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  return {
    id: invoice.id,
    number: invoice.number,
    reference: invoice.reference,
    status: invoice.status as InvoiceStatus,
    displayStatus: displayStatus(
      { status: invoice.status as InvoiceStatus, dueDate: invoice.dueDate },
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
    open: centsToEuros(invoice.grossCents - paidCents),
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
  };
}

export async function createInvoice(
  userId: string,
  input: CreateInvoiceInput
): Promise<PublicInvoice> {
  const customer = await requireActiveCustomer(userId, input.customerId);
  const lineInputs = toLineInputs(input.lines);
  const totals = computeInvoiceTotals(lineInputs);

  const issueDate = isoDateToUtc(input.issueDate);
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

  // Two invoices created at the same moment would propose the same number; the
  // unique index rejects the loser, so retry with a fresh number.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const number = await nextInvoiceNumber(userId);
    try {
      const created = await prisma.salesInvoice.create({
        data: {
          userId,
          customerId: customer.id,
          number,
          reference: referenceForInvoice(number),
          issueDate,
          dueDate,
          notes: input.notes?.trim() || null,
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
        include: invoiceInclude,
      });
      return toPublicInvoice(created);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "P2002") throw error;
    }
  }
  throw new AppError("Laskunumeron varaus epäonnistui, yritä uudelleen.", "NUMBER_RACE", 409);
}

export async function getInvoice(userId: string, id: string): Promise<PublicInvoice> {
  const invoice = await prisma.salesInvoice.findFirst({
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
    select: { id: true, status: true, issueDate: true, dueDate: true },
  });
  if (!existing) throw new NotFoundError("Laskua ei löytynyt.");

  const isDraft = existing.status === "draft";
  if (!isDraft && (input.lines || input.customerId || input.issueDate)) {
    throw new AppError(
      "Lähetetyn laskun rivejä, asiakasta tai päivää ei voi muuttaa. Hyvitä lasku ja tee uusi.",
      "INVOICE_LOCKED",
      409
    );
  }

  const data: Record<string, unknown> = {};
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

    await prisma.$transaction([
      prisma.invoiceLine.deleteMany({ where: { invoiceId: id } }),
      prisma.invoiceLine.createMany({
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
      }),
      prisma.salesInvoice.update({ where: { id }, data }),
    ]);
  } else if (Object.keys(data).length > 0) {
    await prisma.salesInvoice.update({ where: { id }, data });
  }

  return getInvoice(userId, id);
}

export async function deleteInvoice(userId: string, id: string): Promise<void> {
  const existing = await prisma.salesInvoice.findFirst({
    where: { id, userId },
    select: { id: true, status: true },
  });
  if (!existing) throw new NotFoundError("Laskua ei löytynyt.");
  if (existing.status !== "draft") {
    throw new AppError(
      "Vain luonnoksen voi poistaa. Lähetetty lasku hyvitetään.",
      "INVOICE_LOCKED",
      409
    );
  }
  await prisma.salesInvoice.delete({ where: { id } });
}

export async function setInvoiceStatus(
  userId: string,
  id: string,
  target: InvoiceStatus
): Promise<PublicInvoice> {
  const existing = await prisma.salesInvoice.findFirst({
    where: { id, userId },
    include: { payments: { select: { amountCents: true } }, lines: { select: { id: true } } },
  });
  if (!existing) throw new NotFoundError("Laskua ei löytynyt.");

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
  }
  if (target === "paid") data.paidAt = new Date();
  if (target === "draft") {
    data.sentAt = null;
    data.paidAt = null;
  }

  await prisma.salesInvoice.update({ where: { id }, data });
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
  input: RecordPaymentInput
): Promise<PublicInvoice> {
  const invoice = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, userId },
    include: { payments: { select: { amountCents: true } } },
  });
  if (!invoice) throw new NotFoundError("Laskua ei löytynyt.");
  if (invoice.status === "draft") {
    throw new AppError("Luonnokselle ei voi kirjata maksua.", "INVOICE_IS_DRAFT", 409);
  }
  if (invoice.status === "credited") {
    throw new AppError("Hyvitetylle laskulle ei voi kirjata maksua.", "INVOICE_CREDITED", 409);
  }

  const amountCents = eurosToCents(input.amount);
  if (amountCents === 0) throw new ValidationError("Maksun summa ei voi olla nolla.");

  if (input.transactionId) {
    const transaction = await prisma.transaction.findFirst({
      where: { id: input.transactionId, statement: { userId } },
      select: { id: true },
    });
    if (!transaction) throw new NotFoundError("Tapahtumaa ei löytynyt.");
    const taken = await prisma.invoicePayment.findUnique({
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

  await prisma.invoicePayment.create({
    data: {
      invoiceId,
      transactionId: input.transactionId ?? null,
      paidDate: isoDateToUtc(input.paidDate),
      amountCents,
      source: input.source ?? "manual",
      note: input.note?.trim() || null,
    },
  });

  const paidCents =
    invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0) + amountCents;
  if (paidCents >= invoice.grossCents && invoice.status === "sent") {
    await prisma.salesInvoice.update({
      where: { id: invoiceId },
      data: { status: "paid", paidAt: isoDateToUtc(input.paidDate) },
    });
  }

  return getInvoice(userId, invoiceId);
}

export async function removePayment(
  userId: string,
  invoiceId: string,
  paymentId: string
): Promise<PublicInvoice> {
  const invoice = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, userId },
    select: { id: true, status: true },
  });
  if (!invoice) throw new NotFoundError("Laskua ei löytynyt.");

  const deleted = await prisma.invoicePayment.deleteMany({
    where: { id: paymentId, invoiceId },
  });
  if (deleted.count === 0) throw new NotFoundError("Maksua ei löytynyt.");

  // Removing a payment reopens an invoice that was only closed by it.
  if (invoice.status === "paid") {
    const remaining = await prisma.invoicePayment.aggregate({
      where: { invoiceId },
      _sum: { amountCents: true },
    });
    const full = await prisma.salesInvoice.findUnique({
      where: { id: invoiceId },
      select: { grossCents: true },
    });
    if ((remaining._sum.amountCents ?? 0) < (full?.grossCents ?? 0)) {
      await prisma.salesInvoice.update({
        where: { id: invoiceId },
        data: { status: "sent", paidAt: null },
      });
    }
  }

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
  if (options.status && options.status !== "all" && options.status !== "overdue") {
    where.status = options.status;
  }

  const rows = await prisma.salesInvoice.findMany({
    where,
    include: invoiceInclude,
    orderBy: [{ issueDate: "desc" }, { number: "desc" }],
    take: options.limit ?? 200,
  });

  let invoices = rows.map((row) => toPublicInvoice(row, now));
  // "overdue" is derived, so it is filtered after mapping rather than in SQL.
  if (options.status === "overdue") {
    invoices = invoices.filter((invoice) => invoice.displayStatus === "overdue");
  }

  const allOpen = await prisma.salesInvoice.findMany({
    where: { userId, status: "sent" },
    select: { status: true, dueDate: true, grossCents: true, payments: { select: { amountCents: true } } },
  });
  const aging = buildAgingReport(
    allOpen.map((invoice) => ({
      status: invoice.status as InvoiceStatus,
      dueDate: invoice.dueDate,
      grossCents: invoice.grossCents,
      paidCents: invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0),
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
    where: { userId, status: "sent" },
    include: { payments: { select: { amountCents: true } } },
  });
  if (openInvoices.length === 0) return { applied: [], suggestions: [] };

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
  const consumed = new Set<string>();

  for (const transaction of incoming) {
    const candidates = [transaction.reference, transaction.message]
      .filter((value): value is string => Boolean(value))
      .map(normalizeReference);

    const invoice = candidates.map((value) => byReference.get(value)).find(Boolean);
    if (!invoice) continue;

    await recordPayment(userId, invoice.id, {
      amount: centsToEuros(transaction.amountCents),
      paidDate: (transaction.date ?? now).toISOString().slice(0, 10),
      transactionId: transaction.id,
      source: "bank",
      note: "Kohdistettu viitenumerolla",
    });
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

  return { applied, suggestions };
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Assembles everything the PDF needs. The seller block comes from the user's
 * own profile, so an incomplete profile produces a visibly incomplete invoice
 * rather than a plausible-looking one with invented details.
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
    },
  });
  if (!invoice) throw new NotFoundError("Laskua ei löytynyt.");

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("Käyttäjää ei löytynyt.");

  const totals = computeInvoiceTotals(
    invoice.lines.map((line) => ({
      quantityMilli: line.quantityMilli,
      unitPriceCents: line.unitPriceCents,
      vatRatePermille: line.vatRatePermille,
    }))
  );

  return {
    number: invoice.number,
    reference: invoice.reference,
    issueDate: invoice.issueDate.toISOString().slice(0, 10),
    dueDate: invoice.dueDate.toISOString().slice(0, 10),
    notes: invoice.notes,
    netCents: invoice.netCents,
    vatCents: invoice.vatCents,
    grossCents: invoice.grossCents,
    breakdown: totals.breakdown,
    seller: {
      name: user.businessName?.trim() || `${user.firstName} ${user.lastName}`.trim(),
      businessId: user.businessId,
      addressStreet: user.addressStreet,
      addressPostalCode: user.addressPostalCode,
      addressCity: user.addressCity,
      email: user.email,
      phone: user.phone,
      iban: user.invoiceIban,
      bic: user.invoiceBic,
      terms: user.invoiceTerms,
      vatRegistered: user.vatRegistered,
    },
    customer: {
      name: invoice.customer.name,
      businessId: invoice.customer.businessId,
      email: invoice.customer.email,
      addressStreet: invoice.customer.addressStreet,
      addressPostalCode: invoice.customer.addressPostalCode,
      addressCity: invoice.customer.addressCity,
    },
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
export function invoicePdfFileName(number: number): string {
  return `lasku-${String(number).padStart(4, "0")}.pdf`;
}
