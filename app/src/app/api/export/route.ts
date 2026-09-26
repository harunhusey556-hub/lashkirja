import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { csvAttachmentHeaders, csvMoney, toCsv, type CsvValue } from "@/lib/csv";
import { centsToEuros } from "@/lib/money";
import { monthSchema } from "@/lib/validation";
import { displayStatus, type InvoiceStatus } from "@/lib/invoices";

const typeSchema = z.enum([
  "receipts",
  "transactions",
  "invoices",
  "purchase-invoices",
  "customers",
]);

function monthWindow(month: string | null) {
  if (!month) return undefined;
  const parsed = monthSchema.parse(month);
  const [year, monthNumber] = parsed.split("-").map(Number);
  return {
    gte: new Date(Date.UTC(year, monthNumber - 1, 1)),
    lt: new Date(Date.UTC(year, monthNumber, 1)),
  };
}

function isoDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const userId = session.userId;
  const params = req.nextUrl.searchParams;
  const type = typeSchema.parse(params.get("type") ?? "receipts");
  const window = monthWindow(params.get("month"));
  const suffix = params.get("month") ? `-${params.get("month")}` : "";

  let headers: string[] = [];
  let rows: CsvValue[][] = [];
  let fileName = "";

  if (type === "receipts") {
    const receipts = await prisma.receipt.findMany({
      where: { userId, ...(window ? { date: window } : {}) },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      select: {
        date: true,
        vendor: true,
        category: true,
        type: true,
        totalAmountCents: true,
        invoiceNumber: true,
        reference: true,
        reviewStatus: true,
        fileName: true,
      },
    });
    headers = [
      "Päivä", "Toimittaja", "Kategoria", "Tyyppi", "Summa", "Laskun numero",
      "Viite", "Tila", "Tiedosto",
    ];
    rows = receipts.map((receipt) => [
      isoDate(receipt.date),
      receipt.vendor,
      receipt.category,
      receipt.type,
      csvMoney(receipt.totalAmountCents === null ? null : centsToEuros(receipt.totalAmountCents)),
      receipt.invoiceNumber,
      receipt.reference,
      receipt.reviewStatus,
      receipt.fileName,
    ]);
    fileName = `kuitit${suffix}.csv`;
  } else if (type === "transactions") {
    const transactions = await prisma.transaction.findMany({
      where: {
        statement: { userId },
        ...(window ? { date: window } : {}),
      },
      orderBy: [{ date: "asc" }],
      select: {
        date: true,
        counterparty: true,
        amountCents: true,
        reference: true,
        message: true,
        type: true,
        matchStatus: true,
        statement: { select: { bankAccount: { select: { name: true } } } },
      },
    });
    headers = ["Päivä", "Pankkitili", "Vastapuoli", "Summa", "Viite", "Viesti", "Tyyppi", "Täsmäytys"];
    rows = transactions.map((transaction) => [
      isoDate(transaction.date),
      transaction.statement.bankAccount?.name ?? "",
      transaction.counterparty,
      csvMoney(centsToEuros(transaction.amountCents)),
      transaction.reference,
      transaction.message,
      transaction.type,
      transaction.matchStatus,
    ]);
    fileName = `tilitapahtumat${suffix}.csv`;
  } else if (type === "invoices") {
    const invoices = await prisma.salesInvoice.findMany({
      where: { userId, ...(window ? { issueDate: window } : {}) },
      orderBy: [{ number: "asc" }],
      include: {
        customer: { select: { name: true, businessId: true } },
        payments: { select: { amountCents: true } },
      },
    });
    headers = [
      "Numero", "Päivä", "Eräpäivä", "Asiakas", "Y-tunnus", "Viitenumero",
      "Veroton", "ALV", "Yhteensä", "Maksettu", "Avoinna", "Tila",
    ];
    rows = invoices.map((invoice) => {
      const paidCents = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
      return [
        invoice.number,
        isoDate(invoice.issueDate),
        isoDate(invoice.dueDate),
        invoice.customer.name,
        invoice.customer.businessId,
        invoice.reference,
        csvMoney(centsToEuros(invoice.netCents)),
        csvMoney(centsToEuros(invoice.vatCents)),
        csvMoney(centsToEuros(invoice.grossCents)),
        csvMoney(centsToEuros(paidCents)),
        csvMoney(centsToEuros(invoice.grossCents - paidCents)),
        displayStatus({ status: invoice.status as InvoiceStatus, dueDate: invoice.dueDate }),
      ];
    });
    fileName = `myyntilaskut${suffix}.csv`;
  } else if (type === "purchase-invoices") {
    const invoices = await prisma.purchaseInvoice.findMany({
      where: { userId, ...(window ? { issueDate: window } : {}) },
      orderBy: [{ dueDate: "asc" }],
      include: { payments: { select: { amountCents: true } } },
    });
    headers = [
      "Päivä", "Eräpäivä", "Toimittaja", "Laskun numero", "Viitenumero",
      "Veroton", "ALV", "Yhteensä", "Maksettu", "Avoinna", "Tila", "Kategoria",
    ];
    rows = invoices.map((invoice) => {
      const paidCents = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
      return [
        isoDate(invoice.issueDate),
        isoDate(invoice.dueDate),
        invoice.supplierName,
        invoice.invoiceNumber,
        invoice.reference,
        csvMoney(centsToEuros(invoice.netCents)),
        csvMoney(centsToEuros(invoice.vatCents)),
        csvMoney(centsToEuros(invoice.grossCents)),
        csvMoney(centsToEuros(paidCents)),
        csvMoney(centsToEuros(invoice.grossCents - paidCents)),
        invoice.status,
        invoice.category,
      ];
    });
    fileName = `ostolaskut${suffix}.csv`;
  } else {
    const customers = await prisma.customer.findMany({
      where: { userId },
      orderBy: { name: "asc" },
    });
    headers = [
      "Nimi", "Y-tunnus", "Sähköposti", "Puhelin", "Osoite", "Postinumero",
      "Postitoimipaikka", "Maksuaika (pv)", "Arkistoitu",
    ];
    rows = customers.map((customer) => [
      customer.name,
      customer.businessId,
      customer.email,
      customer.phone,
      customer.addressStreet,
      customer.addressPostalCode,
      customer.addressCity,
      customer.defaultPaymentTermDays,
      customer.archivedAt ? "kyllä" : "",
    ]);
    fileName = "asiakkaat.csv";
  }

  return new NextResponse(toCsv(headers, rows), { headers: csvAttachmentHeaders(fileName) });
});
