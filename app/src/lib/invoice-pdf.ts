/**
 * Sales invoice PDF.
 *
 * Rendered server-side with pdfkit so the file is identical wherever it is
 * produced - the customer's copy, the emailed attachment and the archived
 * document are the same bytes, not whatever a particular browser printed.
 */
import PDFDocument from "pdfkit";
import { formatIban } from "./iban";
import { formatReference } from "./finnish-reference";
import { buildBankBarcode, formatBankBarcode } from "./bank-barcode";
import { barcodeRects } from "./code128";
import { pdfFontFiles } from "./pdf-fonts";
import { pdfMoney, sanitizePdfText, winAnsiCanDraw } from "./pdf-text";

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
  documentKind?: "invoice" | "credit_note";
  originalNumber?: number | null;
  /** An unissued draft: the page carries a LUONNOS mark so it cannot pass for the real invoice. */
  draft?: boolean;
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

/**
 * Same money formatting as the screens, so a printed invoice matches the app,
 * except the minus sign: the PDF font has no U+2212 (F02, G01).
 */
const eur = pdfMoney;

interface PdfFonts {
  regular: string;
  bold: string;
}

interface PdfContext {
  doc: InstanceType<typeof PDFDocument>;
  fonts: PdfFonts;
  /** Every string printed on the page goes through this first. */
  text: (value: string | null | undefined) => string;
}

/**
 * One document with the Unicode font registered when it is on disk, plus the
 * sanitiser for what that font (or Helvetica, as the fallback) cannot draw.
 */
function createPdf(): PdfContext {
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  const files = pdfFontFiles();
  let fonts: PdfFonts = { regular: "Helvetica", bold: "Helvetica-Bold" };
  let canDraw = winAnsiCanDraw;
  if (files) {
    try {
      doc.registerFont("Body", files.regular);
      doc.registerFont("Body-Bold", files.bold);
      doc.font("Body");
      fonts = { regular: "Body", bold: "Body-Bold" };
      const face = (
        doc as unknown as {
          _font?: { font?: { hasGlyphForCodePoint?: (codePoint: number) => boolean } };
        }
      )._font?.font;
      if (face?.hasGlyphForCodePoint) {
        canDraw = (codePoint) => face.hasGlyphForCodePoint!(codePoint);
      }
    } catch {
      // An unreadable font file must not cost the customer their invoice.
      fonts = { regular: "Helvetica", bold: "Helvetica-Bold" };
      canDraw = winAnsiCanDraw;
    }
  }
  return { doc, fonts, text: (value) => sanitizePdfText(value, canDraw) };
}

/**
 * A faint diagonal LUONNOS across the current page. The layout cursor is put
 * back afterwards, because the page text below is placed relative to it.
 */
function drawDraftMark(doc: InstanceType<typeof PDFDocument>, boldFont: string): void {
  const { x, y } = doc;
  const { width, height } = doc.page;
  doc.save();
  doc.fillColor("#c62828").fillOpacity(0.16).font(boldFont).fontSize(110);
  doc.rotate(-30, { origin: [width / 2, height / 2] });
  doc.text("LUONNOS", 0, height / 2 - 60, { width, align: "center", lineBreak: false });
  doc.restore();
  doc.x = x;
  doc.y = y;
}

function cleanParty<T extends object>(party: T, clean: PdfContext["text"]): T {
  const result = { ...party } as Record<string, unknown>;
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "string") result[key] = clean(value);
  }
  return result as T;
}

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

export function renderInvoicePdf(input: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { doc, fonts, text: clean } = createPdf();
    const data: InvoicePdfData = {
      ...input,
      notes: input.notes ? clean(input.notes) : input.notes,
      seller: cleanParty(input.seller, clean),
      customer: cleanParty(input.customer, clean),
      lines: input.lines.map((line) => ({
        ...line,
        description: clean(line.description),
        unit: clean(line.unit),
      })),
    };
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (data.draft) {
      drawDraftMark(doc, fonts.bold);
      doc.on("pageAdded", () => drawDraftMark(doc, fonts.bold));
    }

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // Seller
    doc.font(fonts.bold).fontSize(16).text(data.seller.name, left, 48);
    doc.font(fonts.regular).fontSize(9);
    for (const line of addressLines(data.seller)) doc.text(line);
    if (data.seller.businessId) doc.text(`Y-tunnus ${data.seller.businessId}`);
    if (data.seller.email) doc.text(data.seller.email);
    if (data.seller.phone) doc.text(data.seller.phone);
    // The document is what it says: the exemption is printed only when no line
    // carries VAT, and the VAT columns and breakdown only when some do or the
    // seller is registered (F01). An invoice issued before the seller was
    // corrected keeps showing the VAT it actually charged, without a
    // statement that contradicts it.
    const chargesVat =
      data.seller.vatRegistered || data.lines.some((line) => line.vatRatePermille > 0);
    if (!data.seller.vatRegistered && !chargesVat) {
      doc.text("Ei arvonlisäverovelvollinen (AVL 3 §)");
    }

    const creditNote = data.documentKind === "credit_note";
    // Invoice header block, right-aligned
    doc
      .font(fonts.bold)
      .fontSize(20)
      .text(creditNote ? "HYVITYSLASKU" : "LASKU", left, 48, { width, align: "right" });
    doc.font(fonts.regular).fontSize(9);
    // A credit note is not payable: no due date and no payment reference.
    const headerRows: Array<[string, string]> = creditNote
      ? [
          ["Laskun numero", String(data.number)],
          ["Laskun päivä", fiDate(data.issueDate)],
        ]
      : [
          ["Laskun numero", String(data.number)],
          ["Laskun päivä", fiDate(data.issueDate)],
          ["Eräpäivä", fiDate(data.dueDate)],
          ["Viitenumero", formatReference(data.reference)],
        ];
    if (creditNote && data.originalNumber) {
      headerRows.push(["Hyvittää laskun", String(data.originalNumber)]);
    }
    let headerY = 74;
    for (const [label, value] of headerRows) {
      doc.text(`${label}: ${value}`, left, headerY, { width, align: "right" });
      headerY += 13;
    }

    // Customer
    let y = Math.max(doc.y, headerY) + 24;
    doc.font(fonts.bold).fontSize(10).text("Laskutetaan", left, y);
    doc.font(fonts.regular).fontSize(10).text(data.customer.name);
    doc.fontSize(9);
    for (const line of addressLines(data.customer)) doc.text(line);
    if (data.customer.businessId) doc.text(`Y-tunnus ${data.customer.businessId}`);
    if (data.customer.email) doc.text(data.customer.email);

    // Lines
    y = doc.y + 24;
    const columns = chargesVat
      ? {
          description: left,
          quantity: left + width * 0.46,
          unitPrice: left + width * 0.6,
          vat: left + width * 0.75,
          net: left + width * 0.86,
        }
      : {
          description: left,
          quantity: left + width * 0.5,
          unitPrice: left + width * 0.64,
          vat: 0,
          net: left + width * 0.82,
        };
    const descriptionWidth = chargesVat ? width * 0.44 : width * 0.48;
    const netWidth = chargesVat ? width * 0.14 : width * 0.18;

    doc.font(fonts.bold).fontSize(9);
    doc.text("Kuvaus", columns.description, y);
    doc.text("Määrä", columns.quantity, y, { width: width * 0.12, align: "right" });
    doc.text("á hinta", columns.unitPrice, y, { width: width * 0.13, align: "right" });
    if (chargesVat) doc.text("ALV", columns.vat, y, { width: width * 0.09, align: "right" });
    doc.text(chargesVat ? "Veroton" : "Summa", columns.net, y, { width: netWidth, align: "right" });
    y += 14;
    doc.moveTo(left, y).lineTo(right, y).strokeColor("#cccccc").stroke();
    y += 8;

    doc.font(fonts.regular).fontSize(9);
    for (const line of data.lines) {
      const height = doc.heightOfString(line.description, { width: descriptionWidth });
      doc.text(line.description, columns.description, y, { width: descriptionWidth });
      doc.text(`${quantity(line.quantityMilli)} ${line.unit}`, columns.quantity, y, {
        width: width * 0.12,
        align: "right",
      });
      doc.text(eur(line.unitPriceCents), columns.unitPrice, y, {
        width: width * 0.13,
        align: "right",
      });
      if (chargesVat) {
        doc.text(`${String(line.vatRatePermille / 10).replace(".", ",")} %`, columns.vat, y, {
          width: width * 0.09,
          align: "right",
        });
      }
      doc.text(eur(line.netCents), columns.net, y, { width: netWidth, align: "right" });
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
      doc.font(bold ? fonts.bold : fonts.regular).fontSize(bold ? 11 : 9);
      doc.text(label, totalsLeft, y, { width: totalsWidth * 0.55 });
      doc.text(value, totalsLeft + totalsWidth * 0.55, y, {
        width: totalsWidth * 0.45,
        align: "right",
      });
      y += bold ? 18 : 13;
    };

    if (chargesVat) {
      totalRow("Veroton yhteensä", eur(data.netCents));
      for (const row of data.breakdown) {
        if (row.vatCents === 0 && row.ratePermille === 0) continue;
        totalRow(`ALV ${String(row.ratePermille / 10).replace(".", ",")} %`, eur(row.vatCents));
      }
    }
    totalRow("Yhteensä", eur(data.grossCents), true);

    if (creditNote) {
      // Not a request for payment: no IBAN, due date, amount to pay or barcode.
      y += 16;
      doc.font(fonts.bold).fontSize(10).text("Hyvityslasku", left, y);
      y = doc.y + 4;
      doc.font(fonts.regular).fontSize(9);
      doc.text("Tämä on hyvityslasku, ei maksettava lasku.", left, y, { width });
      y = doc.y;
      if (data.originalNumber) {
        doc.text(
          `Hyvitys vähentää laskun ${data.originalNumber} avointa saatavaa. ` +
            "Jos lasku on jo maksettu, myyjä palauttaa summan sinulle erikseen.",
          left,
          y,
          { width }
        );
        y = doc.y;
      }
      y += 8;
    }

    // Payment details
    if (!creditNote) {
      y += 16;
      doc.font(fonts.bold).fontSize(10).text("Maksutiedot", left, y);
      y = doc.y + 4;
      doc.font(fonts.regular).fontSize(9);
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
    }

    const barcode = data.seller.iban && !creditNote
      ? buildBankBarcode({
          iban: data.seller.iban,
          reference: data.reference,
          amountCents: data.grossCents,
          dueDate: `${data.dueDate}T00:00:00.000Z`,
        })
      : null;
    if (barcode) {
      y = drawBankBarcode(doc, barcode, { left, y, width, regularFont: fonts.regular });
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

/* ------------------------------------------------------------------ */
/* Payment reminder                                                    */
/* ------------------------------------------------------------------ */

export interface ReminderPdfData {
  level: number;
  invoiceNumber: number;
  reference: string;
  originalIssueDate: string;
  originalDueDate: string;
  /** New due date printed on the reminder. */
  dueDate: string;
  daysLate: number;
  openCents: number;
  interestCents: number;
  feeCents: number;
  totalCents: number;
  annualRatePercent: number | null;
  seller: InvoicePdfSeller;
  customer: InvoicePdfCustomer;
  notes?: string | null;
}

/**
 * The reminder repeats the original invoice's reference on purpose: the
 * customer pays the same reference, so an incoming payment still reconciles
 * automatically against the invoice it belongs to.
 */
export function renderReminderPdf(input: ReminderPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { doc, fonts, text: clean } = createPdf();
    const data: ReminderPdfData = {
      ...input,
      notes: input.notes ? clean(input.notes) : input.notes,
      seller: cleanParty(input.seller, clean),
      customer: cleanParty(input.customer, clean),
    };
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    doc.font(fonts.bold).fontSize(16).text(data.seller.name, left, 48);
    doc.font(fonts.regular).fontSize(9);
    for (const line of addressLines(data.seller)) doc.text(line);
    if (data.seller.businessId) doc.text(`Y-tunnus ${data.seller.businessId}`);
    if (data.seller.email) doc.text(data.seller.email);
    if (data.seller.phone) doc.text(data.seller.phone);

    const title = data.level > 1 ? `MAKSUMUISTUTUS ${data.level}` : "MAKSUMUISTUTUS";
    doc.font(fonts.bold).fontSize(20).text(title, left, 48, { width, align: "right" });
    doc.font(fonts.regular).fontSize(9);
    let headerY = 74;
    for (const [label, value] of [
      ["Koskee laskua", String(data.invoiceNumber)],
      ["Laskun päivä", fiDate(data.originalIssueDate)],
      ["Alkuperäinen eräpäivä", fiDate(data.originalDueDate)],
      ["Maksettava viimeistään", fiDate(data.dueDate)],
      ["Viitenumero", formatReference(data.reference)],
    ] as Array<[string, string]>) {
      doc.text(`${label}: ${value}`, left, headerY, { width, align: "right" });
      headerY += 13;
    }

    let y = Math.max(doc.y, headerY) + 24;
    doc.font(fonts.bold).fontSize(10).text("Vastaanottaja", left, y);
    doc.font(fonts.regular).fontSize(10).text(data.customer.name);
    doc.fontSize(9);
    for (const line of addressLines(data.customer)) doc.text(line);
    if (data.customer.businessId) doc.text(`Y-tunnus ${data.customer.businessId}`);

    y = doc.y + 20;
    doc
      .fontSize(10)
      .text(
        `Laskun ${data.invoiceNumber} eräpäivä on ylittynyt ${data.daysLate} päivällä. ` +
          "Ellei maksu ole jo matkalla, pyydämme suorittamaan sen alla olevilla tiedoilla.",
        left,
        y,
        { width }
      );

    y = doc.y + 18;
    const totalsLeft = left + width * 0.45;
    const totalsWidth = width * 0.55;
    const row = (label: string, value: string, bold = false) => {
      doc.font(bold ? fonts.bold : fonts.regular).fontSize(bold ? 11 : 9);
      doc.text(label, totalsLeft, y, { width: totalsWidth * 0.6 });
      doc.text(value, totalsLeft + totalsWidth * 0.6, y, {
        width: totalsWidth * 0.4,
        align: "right",
      });
      y += bold ? 18 : 13;
    };

    row("Avoin pääoma", eur(data.openCents));
    if (data.interestCents > 0) {
      const rate = data.annualRatePercent
        ? ` (${String(data.annualRatePercent).replace(".", ",")} % / v, ${data.daysLate} pv)`
        : "";
      row(`Viivästyskorko${rate}`, eur(data.interestCents));
    }
    if (data.feeCents > 0) row("Muistutusmaksu", eur(data.feeCents));
    row("Maksettava yhteensä", eur(data.totalCents), true);

    y += 16;
    doc.font(fonts.bold).fontSize(10).text("Maksutiedot", left, y);
    y = doc.y + 4;
    doc.font(fonts.regular).fontSize(9);
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
    doc.text(`Summa: ${eur(data.totalCents)}`, left, y);
    y = doc.y + 8;

    const barcode = data.seller.iban
      ? buildBankBarcode({
          iban: data.seller.iban,
          reference: data.reference,
          amountCents: data.totalCents,
          dueDate: `${data.dueDate}T00:00:00.000Z`,
        })
      : null;
    if (barcode) {
      y = drawBankBarcode(doc, barcode, { left, y, width, regularFont: fonts.regular });
    }

    if (data.notes) {
      doc.fontSize(9).fillColor("#000000").text(data.notes, left, y + 6, { width });
    }

    doc.end();
  });
}

/**
 * The virtuaaliviivakoodi as bars a bank app or scanner reads (Code 128 C), with its digits
 * underneath for typing. Moves to a new page when the bars would not fit, since a cut barcode
 * cannot be scanned. Returns the y below it.
 */
function drawBankBarcode(
  doc: PDFKit.PDFDocument,
  barcode: string,
  at: { left: number; y: number; width: number; regularFont: string }
): number {
  const barHeight = 36;
  let y = at.y;
  if (y + barHeight + 40 > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.font(at.regularFont).fontSize(8).fillColor("#666666").text("Virtuaaliviivakoodi", at.left, y);
  const top = doc.y + 4;
  const layout = barcodeRects(barcode, { x: at.left, y: top, maxWidth: at.width, height: barHeight });
  doc.save().fillColor("#000000");
  for (const bar of layout.rects) doc.rect(bar.x, bar.y, bar.width, bar.height);
  doc.fill().restore();
  doc
    .font("Courier")
    .fontSize(8)
    .fillColor("#000000")
    .text(formatBankBarcode(barcode), at.left, top + barHeight + 4, { width: at.width });
  doc.font(at.regularFont);
  return doc.y + 8;
}
