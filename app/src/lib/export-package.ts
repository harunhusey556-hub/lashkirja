/**
 * One zip for a month: reports, CSV, match metadata, and document files
 * the user already stored. No bank session secrets and no server paths.
 */
import { prisma } from "./db";
import { loadAlvPeriodSources } from "./alv-period";
import { computeAlvReport } from "./alv";
import { buildProfitLoss, periodToEuros } from "./reports";
import { centsToEuros } from "./money";
import { csvMoney, toCsv, type CsvValue } from "./csv";
import { monthBoundsUtc } from "./validation";
import { readUserUpload, safeOriginalName } from "./storage";
import { displayStatus, type InvoiceStatus } from "./invoices";
import { buildStoredZip, type ZipEntry } from "./zip-store";

const STORAGE_KEY = /^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/;

function isoDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

export async function buildPeriodPackage(
  userId: string,
  month: string
): Promise<{ fileName: string; bytes: Buffer }> {
  const { start, end } = monthBoundsUtc(month);
  const [receipts, transactions, invoices, sources] = await Promise.all([
    prisma.receipt.findMany({
      where: { userId, date: { gte: start, lt: end } },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        date: true,
        vendor: true,
        category: true,
        type: true,
        totalAmountCents: true,
        vatDetails: true,
        invoiceNumber: true,
        reference: true,
        reviewStatus: true,
        fileName: true,
        filePath: true,
      },
    }),
    prisma.transaction.findMany({
      where: { statement: { userId, periodMonth: month } },
      orderBy: [{ date: "asc" }],
      select: {
        id: true,
        date: true,
        counterparty: true,
        amountCents: true,
        reference: true,
        message: true,
        type: true,
        matchStatus: true,
        receiptId: true,
      },
    }),
    prisma.salesInvoice.findMany({
      where: { userId, issueDate: { gte: start, lt: end } },
      orderBy: [{ number: "asc" }],
      include: {
        customer: { select: { name: true, businessId: true } },
        payments: { select: { amountCents: true } },
      },
    }),
    loadAlvPeriodSources(userId, start, end),
  ]);

  const profit = buildProfitLoss(
    receipts
      .filter((receipt) => receipt.reviewStatus === "approved")
      .map((receipt) => ({
        type: receipt.type,
        date: receipt.date,
        totalAmountCents: receipt.totalAmountCents,
        category: receipt.category,
        vatDetails: receipt.vatDetails,
      }))
  );
  const alv = computeAlvReport(sources.receipts, sources.invoices);

  const receiptCsv = toCsv(
    ["Päivä", "Toimittaja", "Kategoria", "Tyyppi", "Summa", "Laskun numero", "Viite", "Tila", "Tiedosto"],
    receipts.map((receipt) => [
      isoDate(receipt.date),
      receipt.vendor,
      receipt.category,
      receipt.type,
      csvMoney(receipt.totalAmountCents == null ? null : centsToEuros(receipt.totalAmountCents)),
      receipt.invoiceNumber,
      receipt.reference,
      receipt.reviewStatus,
      receipt.fileName,
    ])
  );
  const transactionCsv = toCsv(
    ["Päivä", "Vastapuoli", "Summa", "Viite", "Viesti", "Tyyppi", "Täsmäytys", "Kuitti"],
    transactions.map((transaction) => [
      isoDate(transaction.date),
      transaction.counterparty,
      csvMoney(centsToEuros(transaction.amountCents)),
      transaction.reference,
      transaction.message,
      transaction.type,
      transaction.matchStatus,
      transaction.receiptId,
    ])
  );
  const invoiceCsv = toCsv(
    ["Numero", "Päivä", "Eräpäivä", "Asiakas", "Y-tunnus", "Veroton", "ALV", "Yhteensä", "Tila", "Laji"],
    invoices.map((invoice): CsvValue[] => {
      const paidCents = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
      return [
        invoice.number,
        isoDate(invoice.issueDate),
        isoDate(invoice.dueDate),
        invoice.customer.name,
        invoice.customer.businessId,
        csvMoney(centsToEuros(invoice.netCents)),
        csvMoney(centsToEuros(invoice.vatCents)),
        csvMoney(centsToEuros(invoice.grossCents)),
        displayStatus({ status: invoice.status as InvoiceStatus, dueDate: invoice.dueDate }),
        invoice.documentKind,
      ];
    })
  );

  const matches = {
    month,
    basis: "Tilitapahtumat kohdekuukauden (periodMonth) mukaan. Kuitit ja laskut kalenteripäivän mukaan.",
    transactions: transactions.map((transaction) => ({
      id: transaction.id,
      date: isoDate(transaction.date),
      amountCents: transaction.amountCents,
      type: transaction.type,
      matchStatus: transaction.matchStatus,
      receiptId: transaction.receiptId,
      counterparty: transaction.counterparty,
    })),
  };

  const entries: ZipEntry[] = [
    {
      name: "lue-minut.txt",
      data: Buffer.from(
        [
          `Kirjanpitopaketti ${month}`,
          "",
          "Tuloslaskelma perustuu hyväksyttyihin kuitteihin.",
          "ALV perustuu hyväksyttyihin kuitteihin ja lähetettyihin tai maksettuihin myyntilaskuihin. Luonnokset ja hyvityslaskut eivät ole ALV-luvussa.",
          "Käteisnäkymä (kohdistukset.json) käyttää tiliotteen kohdekuukautta, ei kuitin päivää.",
          "Pankin istuntotietoja ei ole tässä paketissa.",
          "",
        ].join("\n"),
        "utf8"
      ),
    },
    {
      name: "raportit/tuloslaskelma.json",
      data: Buffer.from(JSON.stringify({ ...periodToEuros(profit.total), month }, null, 2), "utf8"),
    },
    {
      name: "raportit/alv.json",
      data: Buffer.from(
        JSON.stringify(
          {
            month,
            ...alv,
            excludedReceiptCount: sources.excludedReceiptCount,
            creditedInvoiceCount: sources.creditedInvoiceCount,
          },
          null,
          2
        ),
        "utf8"
      ),
    },
    { name: "csv/kuitit.csv", data: Buffer.from(receiptCsv, "utf8") },
    { name: "csv/tilitapahtumat.csv", data: Buffer.from(transactionCsv, "utf8") },
    { name: "csv/myyntilaskut.csv", data: Buffer.from(invoiceCsv, "utf8") },
    { name: "taydennys/kohdistukset.json", data: Buffer.from(JSON.stringify(matches, null, 2), "utf8") },
  ];

  const missingFiles: string[] = [];
  const usedNames = new Set<string>();
  for (const receipt of receipts) {
    if (!STORAGE_KEY.test(receipt.filePath)) {
      missingFiles.push(`${receipt.fileName}: tiedostoa ei ole tallennettu palvelimelle`);
      continue;
    }
    try {
      const bytes = await readUserUpload(userId, receipt.filePath);
      const base = safeOriginalName(receipt.fileName || "tosite");
      let name = `tositteet/${base}`;
      let n = 2;
      while (usedNames.has(name)) {
        name = `tositteet/${n}-${base}`;
        n += 1;
      }
      usedNames.add(name);
      entries.push({ name, data: bytes });
    } catch {
      missingFiles.push(`${receipt.fileName}: tiedostoa ei löytynyt`);
    }
  }
  if (missingFiles.length > 0) {
    entries.push({
      name: "tositteet/puuttuvat.txt",
      data: Buffer.from(missingFiles.join("\n"), "utf8"),
    });
  }

  return { fileName: `kirjanpito-${month}.zip`, bytes: buildStoredZip(entries) };
}
