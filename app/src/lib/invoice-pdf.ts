/**
 * Sales invoice PDF.
 *
 * Rendered server-side with pdfkit so the file is identical wherever it is
 * produced - the customer's copy, the emailed attachment and the archived
 * document are the same bytes, not whatever a particular browser printed.
 */
import PDFDocument from "pdfkit";
import { centsToEuros } from "./money";
import { formatEur } from "./format";
import { formatIban } from "./iban";
import { formatReference } from "./finnish-reference";
import { buildBankBarcode, formatBankBarcode } from "./bank-barcode";

export interface InvoicePdfSeller {
  name: string;
  businessId?: string | null;
  addressStreet?: string | null;
  addressPostalCode?: string | null;
  addressCity?: string | null;
  email?: string | null;
  phone?: string | null;
  iban?: string | null;
  bic?: string | null;
  terms?: string | null;
  vatRegistered: boolean;
}

export interface InvoicePdfCustomer {
  name: string;
  businessId?: string | null;
  email?: string | null;
  addressStreet?: string | null;
  addressPostalCode?: string | null;
  addressCity?: string | null;
}

export interface InvoicePdfLine {
  description: string;
  quantityMilli: number;
  unit: string;
  unitPriceCents: number;
  vatRatePermille: number;
  netCents: number;
}

export interface InvoicePdfData {
  number: number;
  reference: string;
  issueDate: string; // YYYY-MM-DD
  dueDate: string;
  notes?: string | null;
  netCents: number;
  vatCents: number;
  grossCents: number;
  breakdown: Array<{ ratePermille: number; netCents: number; vatCents: number }>;
  seller: InvoicePdfSeller;
  customer: InvoicePdfCustomer;
  lines: InvoicePdfLine[];
}

/** Same money formatting as the screens, so a printed invoice matches the app. */
const eur = (cents: number) => formatEur(centsToEuros(cents));

const fiDate = (iso: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  return `${Number(match[3])}.${Number(match[2])}.${match[1]}`;
};

const quantity = (milli: number) => {
  const value = milli / 1000;
  return (Number.isInteger(value) ? String(value) : value.toFixed(3)).replace(".", ",");
};

function addressLines(entity: {
  addressStreet?: string | null;
  addressPostalCode?: string | null;
  addressCity?: string | null;
}): string[] {
  const lines: string[] = [];
  if (entity.addressStreet) lines.push(entity.addressStreet);
  const cityLine = [entity.addressPostalCode, entity.addressCity].filter(Boolean).join(" ");
  if (cityLine) lines.push(cityLine);
  return lines;
}

export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // Seller
    doc.font("Helvetica-Bold").fontSize(16).text(data.seller.name, left, 48);
    doc.font("Helvetica").fontSize(9);
    for (const line of addressLines(data.seller)) doc.text(line);
    if (data.seller.businessId) doc.text(`Y-tunnus ${data.seller.businessId}`);
    if (data.seller.email) doc.text(data.seller.email);
    if (data.seller.phone) doc.text(data.seller.phone);
    if (!data.seller.vatRegistered) {
      doc.text("Ei arvonlisäverovelvollinen (AVL 3 §)");
    }

    // Invoice header block, right-aligned
    doc.font("Helvetica-Bold").fontSize(20).text("LASKU", left, 48, { width, align: "right" });
    doc.font("Helvetica").fontSize(9);
    const headerRows: Array<[string, string]> = [
      ["Laskun numero", String(data.number)],
      ["Laskun päivä", fiDate(data.issueDate)],
      ["Eräpäivä", fiDate(data.dueDate)],
      ["Viitenumero", formatReference(data.reference)],
    ];
    let headerY = 74;
    for (const [label, value] of headerRows) {
      doc.text(`${label}: ${value}`, left, headerY, { width, align: "right" });
      headerY += 13;
    }

    // Customer
    let y = Math.max(doc.y, headerY) + 24;
    doc.font("Helvetica-Bold").fontSize(10).text("Laskutetaan", left, y);
    doc.font("Helvetica").fontSize(10).text(data.customer.name);
    doc.fontSize(9);
    for (const line of addressLines(data.customer)) doc.text(line);
    if (data.customer.businessId) doc.text(`Y-tunnus ${data.customer.businessId}`);
    if (data.customer.email) doc.text(data.customer.email);

    // Lines
    y = doc.y + 24;
    const columns = {
      description: left,
      quantity: left + width * 0.46,
      unitPrice: left + width * 0.6,
      vat: left + width * 0.75,
      net: left + width * 0.86,
    };

    doc.font("Helvetica-Bold").fontSize(9);
    doc.text("Kuvaus", columns.description, y);
    doc.text("Määrä", columns.quantity, y, { width: width * 0.12, align: "right" });
    doc.text("á hinta", columns.unitPrice, y, { width: width * 0.13, align: "right" });
    doc.text("ALV", columns.vat, y, { width: width * 0.09, align: "right" });
    doc.text("Veroton", columns.net, y, { width: width * 0.14, align: "right" });
    y += 14;
    doc.moveTo(left, y).lineTo(right, y).strokeColor("#cccccc").stroke();
    y += 8;

    doc.font("Helvetica").fontSize(9);
    for (const line of data.lines) {
      const height = doc.heightOfString(line.description, { width: width * 0.44 });
      doc.text(line.description, columns.description, y, { width: width * 0.44 });
      doc.text(`${quantity(line.quantityMilli)} ${line.unit}`, columns.quantity, y, {
        width: width * 0.12,
        align: "right",
      });
      doc.text(eur(line.unitPriceCents), columns.unitPrice, y, {
        width: width * 0.13,
        align: "right",
      });
      doc.text(`${String(line.vatRatePermille / 10).replace(".", ",")} %`, columns.vat, y, {
        width: width * 0.09,
        align: "right",
      });
      doc.text(eur(line.netCents), columns.net, y, { width: width * 0.14, align: "right" });
      y += Math.max(height, 12) + 6;

      if (y > doc.page.height - 220) {
        doc.addPage();
        y = doc.page.margins.top;
      }
    }

    doc.moveTo(left, y).lineTo(right, y).strokeColor("#cccccc").stroke();
    y += 10;

    // Totals
    const totalsLeft = left + width * 0.55;
    const totalsWidth = width * 0.45;
    const totalRow = (label: string, value: string, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9);
      doc.text(label, totalsLeft, y, { width: totalsWidth * 0.55 });
      doc.text(value, totalsLeft + totalsWidth * 0.55, y, {
        width: totalsWidth * 0.45,
        align: "right",
      });
      y += bold ? 18 : 13;
    };

    totalRow("Veroton yhteensä", eur(data.netCents));
    for (const row of data.breakdown) {
      if (row.vatCents === 0 && row.ratePermille === 0) continue;
      totalRow(`ALV ${String(row.ratePermille / 10).replace(".", ",")} %`, eur(row.vatCents));
    }
    totalRow("Yhteensä", eur(data.grossCents), true);

    // Payment details
    y += 16;
    doc.font("Helvetica-Bold").fontSize(10).text("Maksutiedot", left, y);
    y = doc.y + 4;
    doc.font("Helvetica").fontSize(9);
    if (data.seller.iban) {
      doc.text(`Tilinumero (IBAN): ${formatIban(data.seller.iban)}`, left, y);
      y = doc.y;
    }
    if (data.seller.bic) {
      doc.text(`BIC: ${data.seller.bic}`, left, y);
      y = doc.y;
    }
    doc.text(`Viitenumero: ${formatReference(data.reference)}`, left, y);
    y = doc.y;
    doc.text(`Eräpäivä: ${fiDate(data.dueDate)}`, left, y);
    y = doc.y;
    doc.text(`Summa: ${eur(data.grossCents)}`, left, y);
    y = doc.y + 8;

    const barcode = data.seller.iban
      ? buildBankBarcode({
          iban: data.seller.iban,
          reference: data.reference,
          amountCents: data.grossCents,
          dueDate: `${data.dueDate}T00:00:00.000Z`,
        })
      : null;
    if (barcode) {
      doc.fontSize(8).fillColor("#666666").text("Virtuaaliviivakoodi", left, y);
      doc
        .font("Courier")
        .fontSize(9)
        .fillColor("#000000")
        .text(formatBankBarcode(barcode), left, doc.y);
      doc.font("Helvetica");
      y = doc.y + 8;
    }

    if (data.seller.terms) {
      doc.fontSize(9).fillColor("#000000").text(data.seller.terms, left, y + 6, { width });
      y = doc.y;
    }
    if (data.notes) {
      doc.fontSize(9).text(data.notes, left, y + 6, { width });
    }

    doc.end();
  });
}
