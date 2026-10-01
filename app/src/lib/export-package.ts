/**
 * One zip for a month: reports, CSV, match metadata, and document files
 * the user already stored. No bank session secrets and no server paths.
 */
import { prisma } from "./db";
import { alvReportOf, loadAlvPeriodSources, type PurchaseVatTreatment } from "./alv-period";
import { PURCHASE_STATUS } from "./status-labels";
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

/** What the VAT return did with a purchase invoice, in the words the accountant reads (M1-5). */
const PURCHASE_TREATMENT_TEXT: Record<PurchaseVatTreatment, string> = {
  counted: "Mukana vähennettävässä ALV:ssä",
  linked_receipt: "Pois: liitetty kuitti on mukana",
  bank_receipt: "Pois: maksun tilirivillä on kuitti",
  same_purchase_receipt: "Pois: sama osto on mukana kuittina",
  cancelled: "Pois: mitätöity",
  no_vat: "Ei ALV:ta",
};

/**
 * A package period: one month ("2026-03"), a quarter ("2026-Q1") or a whole
 * year ("2026"), so the accountant gets a quarter or a year in one zip
 * (SALES-21). Returns the UTC bounds and the tiliote target months inside.
 */
export function packagePeriod(period: string): { start: Date; end: Date; months: string[] } {
  const year = /^(\d{4})$/.exec(period);
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  let firstMonth: number;
  let count: number;
  let startYear: number;
  if (year) {
    startYear = Number(year[1]);
    firstMonth = 1;
    count = 12;
  } else if (quarter) {
    startYear = Number(quarter[1]);
    firstMonth = (Number(quarter[2]) - 1) * 3 + 1;
    count = 3;
  } else {
    const { start, end } = monthBoundsUtc(period);
    return { start, end, months: [period] };
  }
  const months = Array.from(
    { length: count },
    (_, index) => `${startYear}-${String(firstMonth + index).padStart(2, "0")}`
  );
  return {
    start: new Date(Date.UTC(startYear, firstMonth - 1, 1)),
    end: new Date(Date.UTC(startYear, firstMonth - 1 + count, 1)),
    months,
  };
}

export async function buildPeriodPackage(
  userId: string,
  month: string
): Promise<{ fileName: string; bytes: Buffer }> {
  const { start, end, months } = packagePeriod(month);
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
      where: { statement: { userId, periodMonth: { in: months } } },
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

  // The same sources as the VAT return and /api/reports/profit-loss.
  const profit = buildProfitLoss(sources.reportReceipts, sources.reportInvoices);
  const alv = alvReportOf(sources);

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
    ["Päivä", "Vastapuoli", "Summa", "Viite", "Viesti", "Tyyppi", "Kohdistus", "Kuitti"],
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

  // The purchase invoices behind field 307, one row each, as the VAT return treated them.
  const purchaseCsv = toCsv(
    ["Päivä", "Toimittaja", "Laskun numero", "Yhteensä", "ALV", "Tila", "ALV:n käsittely", "Huomio"],
    sources.purchaseInvoiceRows.map((row): CsvValue[] => [
      isoDate(row.issueDate),
      row.supplierName,
      row.invoiceNumber,
      csvMoney(centsToEuros(row.grossCents)),
      csvMoney(centsToEuros(row.vatCents)),
      PURCHASE_STATUS[row.status === "paid" || row.status === "cancelled" ? row.status : "open"].label,
      PURCHASE_TREATMENT_TEXT[row.treatment],
      row.suspected
        ? "Samansuuruinen kuitti löytyy, tarkista onko se sama osto"
        : row.receiptUnusable
          ? "Liitetystä kuitista puuttuu päivä tai ALV-erittely"
          : "",
    ])
  );

  const matches = {
    month,
    basis: "Pankkitapahtumat kohdekuukauden (periodMonth) mukaan. Kuitit ja laskut kalenteripäivän mukaan.",
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
          "Tuloslaskelma ja ALV perustuvat hyväksyttyihin kuitteihin ja myyntilaskuihin laskun päivän mukaan (laskutusperuste). Luonnokset eivät ole mukana.",
          "Ostolaskun ALV on mukana vähennettävässä verossa laskun päivän mukaan. Jos sama osto on jo kuittina, ostolaskun ALV jätetään pois (csv/ostolaskut.csv kertoo jokaisesta laskusta, onko se mukana).",
          "Hyvityslasku vähentää myyntiä sillä kaudella, jolla se on annettu. Hyvitetty lasku pysyy omalla kaudellaan.",
          "Tuloa ei lasketa kahteen kertaan: kuitti, joka on tehty laskun maksaneesta pankkitapahtumasta, jätetään pois.",
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
            creditNoteCount: sources.creditNoteCount,
          },
          null,
          2
        ),
        "utf8"
      ),
    },
    { name: "csv/kuitit.csv", data: Buffer.from(receiptCsv, "utf8") },
    { name: "csv/pankkitapahtumat.csv", data: Buffer.from(transactionCsv, "utf8") },
    { name: "csv/myyntilaskut.csv", data: Buffer.from(invoiceCsv, "utf8") },
    { name: "csv/ostolaskut.csv", data: Buffer.from(purchaseCsv, "utf8") },
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
      const base = safeOriginalName(receipt.fileName || "kuitti");
      let name = `kuitit/${base}`;
      let n = 2;
      while (usedNames.has(name)) {
        name = `kuitit/${n}-${base}`;
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
      name: "kuitit/puuttuvat.txt",
      data: Buffer.from(missingFiles.join("\n"), "utf8"),
    });
  }

  return { fileName: `kirjanpito-${month}.zip`, bytes: buildStoredZip(entries) };
}
