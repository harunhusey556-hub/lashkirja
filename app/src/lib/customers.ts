/** Customer register: the counterparties a user invoices. */
import { prisma } from "./db";
import { AppError, NotFoundError, ValidationError } from "./api-errors";
import { isValidBusinessId, normalizeBusinessId } from "./finnish-reference";
import { DEFAULT_PAYMENT_TERM_DAYS, MAX_PAYMENT_TERM_DAYS, openPosition } from "./invoices";
import { centsToEuros } from "./money";

export interface CustomerInput {
  name: string;
  businessId?: string | null;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  addressStreet?: string | null;
  addressPostalCode?: string | null;
  addressCity?: string | null;
  country?: string;
  defaultPaymentTermDays?: number;
  notes?: string | null;
}

export interface PublicCustomer {
  id: string;
  name: string;
  businessId: string | null;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  addressStreet: string | null;
  addressPostalCode: string | null;
  addressCity: string | null;
  country: string;
  defaultPaymentTermDays: number;
  notes: string | null;
  archivedAt: string | null;
}

export interface CustomerWithStats extends PublicCustomer {
  invoiceCount: number;
  openInvoiceCount: number;
  openBalance: number;
  invoicedTotal: number;
  lastInvoiceDate: string | null;
}

type CustomerRow = {
  id: string;
  name: string;
  businessId: string | null;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  addressStreet: string | null;
  addressPostalCode: string | null;
  addressCity: string | null;
  country: string;
  defaultPaymentTermDays: number;
  notes: string | null;
  archivedAt: Date | null;
};

export function toPublicCustomer(row: CustomerRow): PublicCustomer {
  return {
    id: row.id,
    name: row.name,
    businessId: row.businessId,
    contactPerson: row.contactPerson,
    email: row.email,
    phone: row.phone,
    addressStreet: row.addressStreet,
    addressPostalCode: row.addressPostalCode,
    addressCity: row.addressCity,
    country: row.country,
    defaultPaymentTermDays: row.defaultPaymentTermDays,
    notes: row.notes,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

/** Validates the Y-tunnus check digit; empty means "not a company". */
export function prepareBusinessId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!isValidBusinessId(trimmed)) {
    throw new ValidationError("Y-tunnus ei ole kelvollinen (tarkistusmerkki ei täsmää).");
  }
  return normalizeBusinessId(trimmed);
}

function prepareEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  // Deliberately permissive: reject only what can never be an address.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(trimmed)) {
    throw new ValidationError("Sähköpostiosoite ei ole kelvollinen.");
  }
  return trimmed;
}

function preparePaymentTerm(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAYMENT_TERM_DAYS;
  if (!Number.isInteger(value) || value < 0 || value > MAX_PAYMENT_TERM_DAYS) {
    throw new ValidationError("Maksuaika on 0-365 päivää.");
  }
  return value;
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function createCustomer(
  userId: string,
  input: CustomerInput
): Promise<PublicCustomer> {
  const name = input.name.trim();
  if (!name) throw new ValidationError("Asiakkaan nimi puuttuu.");

  const created = await prisma.customer.create({
    data: {
      userId,
      name,
      businessId: prepareBusinessId(input.businessId),
      contactPerson: text(input.contactPerson),
      email: prepareEmail(input.email),
      phone: text(input.phone),
      addressStreet: text(input.addressStreet),
      addressPostalCode: text(input.addressPostalCode),
      addressCity: text(input.addressCity),
      country: (input.country || "FI").toUpperCase(),
      defaultPaymentTermDays: preparePaymentTerm(input.defaultPaymentTermDays),
      notes: text(input.notes),
    },
  });
  return toPublicCustomer(created);
}

export async function updateCustomer(
  userId: string,
  id: string,
  input: Partial<CustomerInput> & { archived?: boolean }
): Promise<PublicCustomer> {
  const existing = await prisma.customer.findFirst({ where: { id, userId } });
  if (!existing) throw new NotFoundError("Asiakasta ei löytynyt.");

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new ValidationError("Asiakkaan nimi puuttuu.");
    data.name = name;
  }
  if (input.businessId !== undefined) data.businessId = prepareBusinessId(input.businessId);
  if (input.contactPerson !== undefined) data.contactPerson = text(input.contactPerson);
  if (input.email !== undefined) data.email = prepareEmail(input.email);
  if (input.phone !== undefined) data.phone = text(input.phone);
  if (input.addressStreet !== undefined) data.addressStreet = text(input.addressStreet);
  if (input.addressPostalCode !== undefined) {
    data.addressPostalCode = text(input.addressPostalCode);
  }
  if (input.addressCity !== undefined) data.addressCity = text(input.addressCity);
  if (input.country !== undefined) data.country = input.country.toUpperCase();
  if (input.defaultPaymentTermDays !== undefined) {
    data.defaultPaymentTermDays = preparePaymentTerm(input.defaultPaymentTermDays);
  }
  if (input.notes !== undefined) data.notes = text(input.notes);
  if (input.archived !== undefined) data.archivedAt = input.archived ? new Date() : null;

  const updated = await prisma.customer.update({ where: { id }, data });
  return toPublicCustomer(updated);
}

export interface CustomerDeleteOutcome {
  deleted: boolean;
  archived: boolean;
  invoiceCount: number;
}

/** A customer with invoice history is archived; the history must survive. */
export async function removeCustomer(
  userId: string,
  id: string
): Promise<CustomerDeleteOutcome> {
  const existing = await prisma.customer.findFirst({ where: { id, userId } });
  if (!existing) throw new NotFoundError("Asiakasta ei löytynyt.");

  const invoiceCount = await prisma.salesInvoice.count({ where: { customerId: id } });
  if (invoiceCount > 0) {
    await prisma.customer.update({ where: { id }, data: { archivedAt: new Date() } });
    return { deleted: false, archived: true, invoiceCount };
  }

  await prisma.customer.delete({ where: { id } });
  return { deleted: true, archived: false, invoiceCount: 0 };
}

export async function listCustomers(
  userId: string,
  options: { includeArchived?: boolean; search?: string } = {}
): Promise<CustomerWithStats[]> {
  const search = options.search?.trim();
  const customers = await prisma.customer.findMany({
    where: {
      userId,
      ...(options.includeArchived ? {} : { archivedAt: null }),
      ...(search ? { name: { contains: search } } : {}),
    },
    orderBy: { name: "asc" },
    include: {
      invoices: {
        select: {
          status: true,
          grossCents: true,
          issueDate: true,
          closedReason: true,
          payments: { select: { amountCents: true } },
        },
      },
    },
  });

  return customers.map((customer) => {
    let openBalanceCents = 0;
    let invoicedCents = 0;
    let openInvoiceCount = 0;
    let lastInvoiceDate: Date | null = null;

    for (const invoice of customer.invoices) {
      if (invoice.status !== "draft" && invoice.status !== "credited") {
        invoicedCents += invoice.grossCents;
      }
      const paid = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
      const position = openPosition({
        status: invoice.status,
        grossCents: invoice.grossCents,
        paidCents: paid,
        closedReason: invoice.closedReason,
      });
      if (position.collectible) {
        openBalanceCents += position.openCents;
        openInvoiceCount += 1;
      }
      if (!lastInvoiceDate || invoice.issueDate > lastInvoiceDate) {
        lastInvoiceDate = invoice.issueDate;
      }
    }

    return {
      ...toPublicCustomer(customer),
      invoiceCount: customer.invoices.length,
      openInvoiceCount,
      openBalance: centsToEuros(openBalanceCents),
      invoicedTotal: centsToEuros(invoicedCents),
      lastInvoiceDate: lastInvoiceDate ? lastInvoiceDate.toISOString().slice(0, 10) : null,
    };
  });
}

export async function getCustomer(userId: string, id: string): Promise<PublicCustomer> {
  const customer = await prisma.customer.findFirst({ where: { id, userId } });
  if (!customer) throw new NotFoundError("Asiakasta ei löytynyt.");
  return toPublicCustomer(customer);
}

/** Guard used by invoice creation. */
export async function requireActiveCustomer(userId: string, id: string) {
  const customer = await prisma.customer.findFirst({ where: { id, userId } });
  if (!customer) throw new NotFoundError("Asiakasta ei löytynyt.");
  if (customer.archivedAt) {
    throw new AppError("Asiakas on arkistoitu.", "CUSTOMER_ARCHIVED", 409);
  }
  return customer;
}
