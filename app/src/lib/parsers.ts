import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import readXlsxFile from "read-excel-file/node";
import type { CellValue, Row } from "read-excel-file/node";
import * as xml2js from "xml2js";
import { isIsoCalendarDate } from "./finnish-numbers";

export interface ParsedTransaction {
  date: string | null;
  counterparty: string | null;
  amount: number;
  reference: string | null;
  message: string | null;
}

export type StatementFormat = "camt" | "xlsx" | "csv" | "pdf";

export class StatementParseError extends Error {
  readonly code: string;
  readonly format: StatementFormat;

  constructor(format: StatementFormat, code: string, message: string) {
    super(message);
    this.name = "StatementParseError";
    this.format = format;
    this.code = code;
  }
}

const MAX_STATEMENT_BYTES = 25 * 1024 * 1024;
const MAX_TRANSACTIONS = 50_000;
const MAX_TEXT_OUTPUT_BYTES = 20 * 1024 * 1024;

function readBoundedFile(filePath: string, format: StatementFormat): Buffer {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new StatementParseError(format, "NOT_A_FILE", "Tiliote ei ole tiedosto");
  }
  if (stat.size === 0) {
    throw new StatementParseError(format, "EMPTY_FILE", "Tiliote on tyhjä");
  }
  if (stat.size > MAX_STATEMENT_BYTES) {
    throw new StatementParseError(
      format,
      "FILE_TOO_LARGE",
      `Tiliote on liian suuri (enintään ${MAX_STATEMENT_BYTES / 1024 / 1024} Mt)`
    );
  }
  return fs.readFileSync(filePath);
}

function finish(
  format: StatementFormat,
  transactions: ParsedTransaction[]
): ParsedTransaction[] {
  if (transactions.length === 0) {
    throw new StatementParseError(
      format,
      "NO_TRANSACTIONS",
      "Tiliotteelta ei löytynyt tapahtumia"
    );
  }
  if (transactions.length > MAX_TRANSACTIONS) {
    throw new StatementParseError(
      format,
      "TOO_MANY_TRANSACTIONS",
      `Tiliotteella on liian monta tapahtumaa (enintään ${MAX_TRANSACTIONS})`
    );
  }
  for (const tx of transactions) {
    if (!Number.isFinite(tx.amount)) {
      throw new StatementParseError(
        format,
        "INVALID_AMOUNT",
        "Tiliotteella on virheellinen summa"
      );
    }
    if (tx.date !== null && !isIsoCalendarDate(tx.date)) {
      throw new StatementParseError(
        format,
        "INVALID_DATE",
        `Tiliotteella on virheellinen päivämäärä: ${tx.date}`
      );
    }
  }
  return transactions;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text || null;
  }
  if (typeof value === "object" && "_" in value) {
    return textValue((value as { _: unknown })._);
  }
  return null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return null;
}

function isoDate(year: number, month: number, day: number): string | null {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isIsoCalendarDate(value) ? value : null;
}

function parseDateValue(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel's 1900 date system, including its historic leap-year offset.
    const utc = new Date(Math.round((value - 25569) * 86_400_000));
    return isoDate(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  let match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:T.*)?$/);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (match) {
    const shortYear = Number(match[3]);
    const year = match[3].length === 2 ? 2000 + shortYear : shortYear;
    return isoDate(year, Number(match[2]), Number(match[1]));
  }
  return null;
}

export function parseAmountValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let raw = value.trim();
  if (!raw) return null;
  let negative = false;
  const spacedSign = raw.match(/^([+-])\s+(.+)$/);
  if (spacedSign) {
    negative = spacedSign[1] === "-";
    raw = spacedSign[2].trim();
  }
  if (/^\(.*\)$/.test(raw)) {
    negative = true;
    raw = raw.slice(1, -1);
  }
  if (/-\s*$/.test(raw)) {
    negative = true;
    raw = raw.replace(/-\s*$/, "");
  }
  raw = raw
    .replace(/[\s\u00a0]/g, "")
    .replace(/(?:EUR|€)/gi, "")
    .replace(/[^\d,.'+-]/g, "")
    .replace(/'/g, "");
  if (!raw || !/\d/.test(raw)) return null;

  const comma = raw.lastIndexOf(",");
  const dot = raw.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const thousands = decimal === "," ? /\./g : /,/g;
    raw = raw.replace(thousands, "").replace(decimal, ".");
  } else if (comma >= 0) {
    const decimals = raw.length - comma - 1;
    raw = decimals === 1 || decimals === 2 ? raw.replace(/,/g, ".") : raw.replace(/,/g, "");
  } else if (dot >= 0) {
    const parts = raw.split(".");
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
      raw = parts.join("");
    }
  }

  const amount = Number(raw);
  if (!Number.isFinite(amount)) return null;
  return negative ? -Math.abs(amount) : amount;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("fi-FI")
    .replace(/\s+/g, " ");
}

function cleanText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

// xml2js intentionally has a dynamic result shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XmlNode = any;

function camtDate(entry: XmlNode): string | null {
  const raw = firstText(
    entry?.BookgDt?.Dt,
    entry?.BookgDt?.DtTm,
    entry?.ValDt?.Dt,
    entry?.ValDt?.DtTm
  );
  if (!raw) return null;
  return parseDateValue(raw.slice(0, 10));
}

function partyName(party: XmlNode): string | null {
  return firstText(party?.Nm, party?.Pty?.Nm, party?.OrgId?.Nm, party?.PrvtId?.Nm);
}

function structuredReference(rmtInf: XmlNode): string | null {
  for (const structured of asArray(rmtInf?.Strd)) {
    const ref = firstText(structured?.CdtrRefInf?.Ref);
    if (ref && !/^NOTPROVIDED$/i.test(ref)) return ref;
  }
  return null;
}

function camtReference(detail: XmlNode, entry: XmlNode): string | null {
  const structured = structuredReference(detail?.RmtInf);
  if (structured) return structured;
  for (const candidate of [
    detail?.Refs?.EndToEndId,
    detail?.Refs?.InstrId,
    detail?.Refs?.MndtId,
    detail?.Refs?.AcctSvcrRef,
    entry?.AcctSvcrRef,
  ]) {
    const ref = textValue(candidate);
    if (ref && !/^NOTPROVIDED$/i.test(ref)) return ref;
  }
  return null;
}

function camtMessage(detail: XmlNode, entry: XmlNode): string | null {
  const unstructured = asArray(detail?.RmtInf?.Ustrd)
    .map(textValue)
    .filter((value): value is string => Boolean(value));
  if (unstructured.length > 0) return unstructured.join(" ");
  return firstText(detail?.AddtlTxInf, entry?.AddtlNtryInf);
}

function camtCounterparty(detail: XmlNode, debit: boolean): string | null {
  const parties = detail?.RltdPties;
  const ordered = debit
    ? [parties?.Cdtr, parties?.UltmtCdtr, parties?.Dbtr, parties?.UltmtDbtr]
    : [parties?.Dbtr, parties?.UltmtDbtr, parties?.Cdtr, parties?.UltmtCdtr];
  for (const party of ordered) {
    const name = partyName(party);
    if (name) return name;
  }
  return null;
}

function txDetailAmount(detail: XmlNode): number | null {
  return parseAmountValue(
    firstText(
      detail?.AmtDtls?.TxAmt?.Amt,
      detail?.AmtDtls?.InstdAmt?.Amt,
      detail?.Amt
    )
  );
}

export async function parseCamtXML(filePath: string): Promise<ParsedTransaction[]> {
  const buffer = readBoundedFile(filePath, "camt");
  let result: XmlNode;
  try {
    result = await xml2js.parseStringPromise(buffer.toString("utf8"), {
      explicitArray: false,
      explicitRoot: true,
      strict: true,
      tagNameProcessors: [xml2js.processors.stripPrefix],
    });
  } catch (error) {
    // The library's own wording (English, line numbers) is for the log, not the owner.
    console.warn("camt XML parse failed:", error instanceof Error ? error.message : error);
    throw new StatementParseError(
      "camt",
      "INVALID_XML",
      "XML-tiliotetta ei voitu lukea. Tiedosto on virheellinen tai katkennut. Lataa se pankista uudelleen."
    );
  }

  const document = result?.Document;
  const reports = [
    ...asArray(document?.BkToCstmrAcctRpt?.Rpt),
    ...asArray(document?.BkToCstmrStmt?.Stmt),
  ];
  if (reports.length === 0) {
    throw new StatementParseError(
      "camt",
      "UNSUPPORTED_CAMT",
      "XML ei ole tuettu camt.052- tai camt.053-tiliote"
    );
  }

  const transactions: ParsedTransaction[] = [];
  for (const report of reports) {
    for (const entry of asArray(report?.Ntry)) {
      const status = firstText(entry?.Sts?.Cd, entry?.Sts);
      if (status && !/^(BOOK|INFO)$/i.test(status)) continue;
      const baseAmount = parseAmountValue(textValue(entry?.Amt));
      if (baseAmount == null) {
        throw new StatementParseError("camt", "INVALID_AMOUNT", "camt-tapahtuman summa puuttuu");
      }
      const indicator = firstText(entry?.CdtDbtInd);
      if (indicator !== "DBIT" && indicator !== "CRDT") {
        throw new StatementParseError(
          "camt",
          "INVALID_DIRECTION",
          "camt-tapahtuman veloitus-/hyvitystieto puuttuu"
        );
      }
      const reversed = /^(true|1)$/i.test(firstText(entry?.RvslInd) || "");
      const debit = indicator === "DBIT";
      const sign = (debit ? -1 : 1) * (reversed ? -1 : 1);
      const currency =
        typeof entry?.Amt === "object" ? firstText(entry.Amt?.$?.Ccy) : null;
      if (currency && currency !== "EUR") {
        throw new StatementParseError(
          "camt",
          "UNSUPPORTED_CURRENCY",
          `Valuuttaa ${currency} ei voi tuoda euromääränä`
        );
      }

      const details = asArray(entry?.NtryDtls?.TxDtls);
      const date = camtDate(entry);
      if (details.length <= 1) {
        const detail = details[0];
        transactions.push({
          date,
          counterparty:
            camtCounterparty(detail, debit) || firstText(entry?.AddtlNtryInf),
          amount: sign * Math.abs(baseAmount),
          reference: camtReference(detail, entry),
          message: camtMessage(detail, entry),
        });
        continue;
      }

      const detailAmounts = details.map(txDetailAmount);
      if (detailAmounts.some((amount) => amount == null)) {
        throw new StatementParseError(
          "camt",
          "AMBIGUOUS_BATCH",
          "camt-koontitapahtuman osasummat puuttuvat"
        );
      }
      const sum = (detailAmounts as number[]).reduce(
        (total, amount) => total + Math.abs(amount),
        0
      );
      if (Math.abs(sum - Math.abs(baseAmount)) > 0.01) {
        throw new StatementParseError(
          "camt",
          "BATCH_TOTAL_MISMATCH",
          "camt-koontitapahtuman osasummat eivät täsmää"
        );
      }
      details.forEach((detail, index) => {
        transactions.push({
          date,
          counterparty:
            camtCounterparty(detail, debit) || firstText(entry?.AddtlNtryInf),
          amount: sign * Math.abs((detailAmounts as number[])[index]),
          reference: camtReference(detail, entry),
          message: camtMessage(detail, entry),
        });
      });
    }
  }
  return finish("camt", transactions);
}

type ColumnKind =
  | "date"
  | "amount"
  | "debit"
  | "credit"
  | "counterparty"
  | "reference"
  | "message"
  | "direction";

interface HeaderMatch {
  rowIndex: number;
  columns: Partial<Record<ColumnKind, number>>;
  score: number;
}

function headerPriority(kind: ColumnKind, header: string): number {
  const exact: Record<ColumnKind, string[]> = {
    date: [
      "kirjauspäivä",
      "booking date",
      "posting date",
      "tarih",
      "päiväys",
      "päivämäärä",
      "pvm",
      "date",
      "maksupäivä",
      "arvopäivä",
      "value date",
    ],
    amount: [
      "summa",
      "summa (€)",
      "yhteensä",
      "amount",
      "amount (€)",
      "tutar",
      "tutar (€)",
      "määrä",
    ],
    debit: ["debit", "veloitus", "otot", "withdrawal"],
    credit: ["credit", "hyvitys", "panot", "deposit"],
    counterparty: [
      "vastapuoli",
      "maksaja / maksun saaja",
      "maksaja/maksun saaja",
      "saaja/maksaja",
      "maksun saaja",
      "saaja",
      "maksaja",
      "counterparty",
      "tedarikçi",
      "müşteri",
      "firma",
      "nimi",
    ],
    reference: ["viitenumero", "viite", "reference", "referans", "ref"],
    message: ["viesti", "message", "selite", "selitys", "açıklama", "kuvaus"],
    direction: ["suunta", "direction", "tyyppi", "type", "yön", "luokka"],
  };
  const index = exact[kind].indexOf(header);
  if (index >= 0) return 100 - index;
  if (kind === "date" && /kirjausp[\u00e4a]iv|booking|posting/.test(header)) return 80;
  if (kind === "amount" && /summa|yhteens[\u00e4a]|amount|tutar/.test(header)) return 80;
  if (kind === "amount" && /^m[\u00e4a][\u00e4a]r[\u00e4a]/.test(header)) return 30;
  if (kind === "counterparty" && /vastapuoli|saaja|maksaja|counterparty/.test(header)) return 60;
  if (kind === "reference" && /viite|referen|ref/.test(header)) return 50;
  if (kind === "message" && /viesti|message|selite|kuvaus/.test(header)) return 50;
  return -1;
}

function discoverHeader(rows: Row[]): HeaderMatch | null {
  let best: HeaderMatch | null = null;
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 60); rowIndex++) {
    const row = rows[rowIndex];
    const columns: Partial<Record<ColumnKind, number>> = {};
    let score = 0;
    for (const kind of [
      "date",
      "amount",
      "debit",
      "credit",
      "counterparty",
      "reference",
      "message",
      "direction",
    ] as ColumnKind[]) {
      let winner = -1;
      let winnerPriority = -1;
      row.forEach((cell, column) => {
        const priority = headerPriority(kind, normalizeHeader(cell));
        if (priority > winnerPriority) {
          winner = column;
          winnerPriority = priority;
        }
      });
      if (winnerPriority >= 0) {
        columns[kind] = winner;
        score += winnerPriority;
      }
    }
    const hasAmount = columns.amount !== undefined ||
      (columns.debit !== undefined && columns.credit !== undefined);
    if (columns.date === undefined || !hasAmount) continue;
    if (!best || score > best.score) best = { rowIndex, columns, score };
  }
  return best;
}

function directionSign(direction: string | null, sheetName: string): 1 | -1 | null {
  const value = `${direction || ""} ${sheetName}`.toLocaleLowerCase("fi-FI");
  if (/expense|outbound|meno|gider|debit|otto|veloitus/.test(value)) return -1;
  if (/income|inbound|tulo|gelir|credit|pano|hyvitys/.test(value)) return 1;
  return null;
}

interface ParsedSheet {
  name: string;
  transactions: ParsedTransaction[];
}

function transactionIdentity(tx: ParsedTransaction): string {
  return [
    tx.date || "",
    (tx.counterparty || "").toLocaleLowerCase("fi-FI"),
    Math.abs(tx.amount).toFixed(2),
  ].join("|");
}

function removeSubsetSheets(sheets: ParsedSheet[]): ParsedSheet[] {
  return sheets.filter((sheet, index) => {
    if (sheet.transactions.length === 0) return false;
    const own = sheet.transactions.map(transactionIdentity);
    return !sheets.some((other, otherIndex) => {
      if (otherIndex === index || other.transactions.length <= sheet.transactions.length) return false;
      const available = new Map<string, number>();
      for (const tx of other.transactions) {
        const key = transactionIdentity(tx);
        available.set(key, (available.get(key) || 0) + 1);
      }
      let overlap = 0;
      for (const key of own) {
        const count = available.get(key) || 0;
        if (count > 0) {
          overlap++;
          available.set(key, count - 1);
        }
      }
      return overlap === own.length;
    });
  });
}

export async function parseXLSX(filePath: string): Promise<ParsedTransaction[]> {
  if (path.extname(filePath).toLowerCase() === ".xls") {
    throw new StatementParseError(
      "xlsx",
      "LEGACY_XLS_UNSUPPORTED",
      "Vanha .xls-muoto ei ole tuettu. Tallenna tiedosto .xlsx-muodossa."
    );
  }
  const buffer = readBoundedFile(filePath, "xlsx");
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new StatementParseError("xlsx", "INVALID_XLSX", "Tiedosto ei ole kelvollinen XLSX");
  }

  let workbook;
  try {
    workbook = await readXlsxFile(buffer);
  } catch (error) {
    console.warn("XLSX read failed:", error instanceof Error ? error.message : error);
    throw new StatementParseError(
      "xlsx",
      "INVALID_XLSX",
      "Excel-tiedostoa ei voitu lukea. Tiedosto on virheellinen tai katkennut. Lataa se pankista uudelleen."
    );
  }

  const parsedSheets: ParsedSheet[] = [];
  for (const sheet of workbook) {
    const rows = sheet.data;
    if (rows.length > MAX_TRANSACTIONS + 100) {
      throw new StatementParseError("xlsx", "TOO_MANY_ROWS", "XLSX-tiedostossa on liian monta riviä");
    }
    const header = discoverHeader(rows);
    if (!header) continue;
    const columns = header.columns;
    const transactions: ParsedTransaction[] = [];
    for (const row of rows.slice(header.rowIndex + 1)) {
      const date = parseDateValue(row[columns.date!]);
      if (!date) continue; // headings, totals and repeated headers are not transactions

      let amount: number | null = null;
      if (columns.amount !== undefined) {
        amount = parseAmountValue(row[columns.amount]);
      } else {
        const debit = parseAmountValue(row[columns.debit!]);
        const credit = parseAmountValue(row[columns.credit!]);
        if (debit != null && debit !== 0) amount = -Math.abs(debit);
        else if (credit != null) amount = Math.abs(credit);
      }
      if (amount == null) {
        throw new StatementParseError(
          "xlsx",
          "INVALID_AMOUNT",
          `XLSX-riviltä ${date} puuttuu kelvollinen summa`
        );
      }
      const direction =
        columns.direction === undefined ? null : cleanText(row[columns.direction]);
      const sign = directionSign(direction, sheet.sheet);
      if (sign) amount = sign * Math.abs(amount);

      transactions.push({
        date,
        counterparty:
          columns.counterparty === undefined
            ? null
            : cleanText(row[columns.counterparty]),
        amount,
        reference:
          columns.reference === undefined ? null : cleanText(row[columns.reference]),
        message:
          columns.message === undefined ? null : cleanText(row[columns.message]),
      });
    }
    if (transactions.length > 0) {
      parsedSheets.push({ name: sheet.sheet, transactions });
    }
  }

  const selected = removeSubsetSheets(parsedSheets);
  return finish(
    "xlsx",
    selected.flatMap((sheet) => sheet.transactions)
  );
}

function decodeCSV(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1];
      swapped[i - 1] = buffer[i];
    }
    return swapped.toString("utf16le");
  }
  const utf8 = buffer.toString("utf8").replace(/^\uFEFF/, "");
  return utf8.includes("\uFFFD") ? buffer.toString("latin1") : utf8;
}

function detectSeparator(text: string): string {
  const firstRecord = text.split(/\r?\n/, 1)[0] || "";
  const counts = [";", ",", "\t"].map((separator) => ({
    separator,
    count: firstRecord.split(separator).length - 1,
  }));
  return counts.sort((a, b) => b.count - a.count)[0].separator;
}

function parseDelimited(text: string, separator: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === separator) {
      record.push(field.trim());
      field = "";
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, "").trim());
      if (record.some(Boolean)) records.push(record);
      record = [];
      field = "";
    } else field += char;
  }
  if (quoted) {
    throw new StatementParseError("csv", "INVALID_CSV", "CSV:ssä on sulkematon lainausmerkki");
  }
  record.push(field.replace(/\r$/, "").trim());
  if (record.some(Boolean)) records.push(record);
  return records;
}

export async function parseCSV(filePath: string): Promise<ParsedTransaction[]> {
  const content = decodeCSV(readBoundedFile(filePath, "csv"));
  const records = parseDelimited(content, detectSeparator(content));
  const header = discoverHeader(records as CellValue[][]);
  if (!header) {
    throw new StatementParseError("csv", "MISSING_HEADERS", "CSV:n sarakkeita ei tunnistettu");
  }
  const columns = header.columns;
  const transactions: ParsedTransaction[] = [];
  for (const row of records.slice(header.rowIndex + 1)) {
    const date = parseDateValue(row[columns.date!]);
    if (!date) continue;
    let amount: number | null = null;
    if (columns.amount !== undefined) amount = parseAmountValue(row[columns.amount]);
    else {
      const debit = parseAmountValue(row[columns.debit!]);
      const credit = parseAmountValue(row[columns.credit!]);
      if (debit != null && debit !== 0) amount = -Math.abs(debit);
      else if (credit != null) amount = Math.abs(credit);
    }
    if (amount == null) {
      throw new StatementParseError("csv", "INVALID_AMOUNT", `CSV-riviltä ${date} puuttuu summa`);
    }
    const direction =
      columns.direction === undefined ? null : cleanText(row[columns.direction]);
    const sign = directionSign(direction, "");
    if (sign) amount = sign * Math.abs(amount);
    transactions.push({
      date,
      counterparty:
        columns.counterparty === undefined ? null : cleanText(row[columns.counterparty]),
      amount,
      reference:
        columns.reference === undefined ? null : cleanText(row[columns.reference]),
      message: columns.message === undefined ? null : cleanText(row[columns.message]),
    });
  }
  return finish("csv", transactions);
}

interface StatementPeriod {
  start: string;
  end: string;
}

function extractStatementPeriod(text: string): StatementPeriod | null {
  const match = text.match(
    /Kausi[\s\S]{0,300}?(\d{1,2}\.\d{1,2}\.\d{4})\s*-\s*(\d{1,2}\.\d{1,2}\.\d{4})/i
  );
  if (!match) return null;
  const start = parseDateValue(match[1]);
  const end = parseDateValue(match[2]);
  return start && end ? { start, end } : null;
}

function dateForDayMonth(dayMonth: string, period: StatementPeriod | null): string | null {
  const match = dayMonth.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (!period) return null;
  const startMs = Date.parse(`${period.start}T00:00:00Z`);
  const endMs = Date.parse(`${period.end}T00:00:00Z`);
  const startYear = Number(period.start.slice(0, 4));
  let best: { value: string; distance: number } | null = null;
  for (const year of [startYear - 1, startYear, startYear + 1]) {
    const value = isoDate(year, month, day);
    if (!value) continue;
    const time = Date.parse(`${value}T00:00:00Z`);
    const distance = time < startMs ? startMs - time : time > endMs ? time - endMs : 0;
    if (!best || distance < best.distance) best = { value, distance };
  }
  return best?.value || null;
}

const PDF_AMOUNT_SOURCE = "[+-][\\d\\s\\u00a0]+[.,]\\d{2}";
const PDF_TX_LINE = new RegExp(
  `\\S+\\s+(\\d{2}\\.\\d{2})\\s{2,}(.+?)\\s{2,}.*?(${PDF_AMOUNT_SOURCE})\\s*$`
);

function pdfTransactionAt(
  lines: string[],
  index: number,
  period: StatementPeriod | null
): ParsedTransaction | null {
  const line = lines[index];
  if (
    /SALDO|PANOT (?:YHTEENSÄ|KIRJAUSPÄIVÄN)|OTOT (?:YHTEENSÄ|KIRJAUSPÄIVÄN)|KUUKAUDEN ALUSTA|VUODEN ALUSTA|KIRJAUSPÄIVÄ/i.test(
      line
    )
  ) {
    return null;
  }
  let match = line.match(PDF_TX_LINE);
  if (!match && index > 0 && /\d{2}\.\d{2}\s*$/.test(lines[index - 1])) {
    match = `${lines[index - 1].trim()}  ${line.trim()}`.match(PDF_TX_LINE);
  }
  if (!match) return null;
  const amount = parseAmountValue(match[3]);
  const date = dateForDayMonth(match[1], period);
  if (amount == null || !date) return null;
  const counterparty = match[2]
    .trim()
    .replace(/\s{2,}/g, " ")
    .replace(/\/[KA]\s*$/, "")
    .replace(/\s+\d+\s*$/, "")
    .trim();
  if (!counterparty || counterparty.length < 2) return null;
  return { date, counterparty, amount, reference: null, message: null };
}

interface PdfSummary {
  count: number;
  net: number;
}

function pdfSummary(text: string): PdfSummary | null {
  const marker = text.lastIndexOf("TILIOTTEEN YHTEENVETOTIEDOT:");
  if (marker < 0) return null;
  const summary = text.slice(marker, marker + 1000);
  const deposits = summary.match(
    /PANOT YHTEENSÄ\s+(\d+)\s+KPL\s+([+]?\s*[\d\s]+[.,]\d{2})/i
  );
  const withdrawals = summary.match(
    /OTOT YHTEENSÄ\s+(\d+)\s+KPL\s+(-\s*[\d\s]+[.,]\d{2})/i
  );
  if (!deposits || !withdrawals) return null;
  const income = parseAmountValue(deposits[2]);
  const expenses = parseAmountValue(withdrawals[2]);
  if (income == null || expenses == null) return null;
  return { count: Number(deposits[1]) + Number(withdrawals[1]), net: income + expenses };
}

export function parseHolviTilioteLayout(text: string): ParsedTransaction[] {
  if (!/HOLVFIHH|Määrä EUR|Kirjauspäivä.*Maksutiedot/i.test(text)) {
    return [];
  }

  const lines = text.split(/\r?\n/);
  const transactions: ParsedTransaction[] = [];
  const headerRe =
    /(\d{1,2}\.\d{1,2}\.\d{4})\s+Arvopäivä:\s*\d{1,2}\.\d{1,2}\.\d{4}\s+\d+\s+([+-])\s*([\d\s]+,\d{2})\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const headerMatch = lines[i].match(headerRe);
    if (!headerMatch) continue;

    const date = parseDateValue(headerMatch[1]);
    const unsigned = parseAmountValue(headerMatch[3]);
    if (!date || unsigned == null) continue;
    const amount =
      headerMatch[2] === "-" ? -Math.abs(unsigned) : Math.abs(unsigned);

    const detailLines: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (headerRe.test(line)) break;
      if (/^SALDO\s+\d/i.test(line.trim())) break;
      if (/^Kirjauspäivä\s+Maksutiedot/i.test(line)) break;
      detailLines.push(line);
    }

    const meta = parseHolviDetailLines(detailLines);
    transactions.push({
      date,
      counterparty: meta.counterparty,
      amount,
      reference: meta.reference,
      message: meta.message,
    });
  }

  return transactions;
}

function parseHolviDetailLines(lines: string[]): {
  counterparty: string | null;
  message: string | null;
  reference: string | null;
} {
  let counterparty: string | null = null;
  let message: string | null = null;
  let reference: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const viiteMatch = line.match(/^viite:\s*(.+)/i);
    if (viiteMatch) {
      reference = viiteMatch[1].trim();
      continue;
    }
    const viestiMatch = line.match(/^viesti:\s*(.+)/i);
    if (viestiMatch) {
      message = viestiMatch[1].trim();
      continue;
    }
    if (/^arkistointitunnus:/i.test(line)) continue;
    if (/^[0-9a-f]{20,}$/i.test(line)) continue;
    if (/^FI\d{2}\s/i.test(line)) continue;
    if (/^varattu:/i.test(line) || /^kello\s/i.test(line)) continue;
    if (/^(sepa-maksu|lähtevä maksu)$/i.test(line)) continue;

    if (!counterparty) {
      counterparty = line.replace(/,\s*$/, "").trim() || null;
    }
  }

  return { counterparty, message, reference };
}

export function parseFinnishBankStatementLayout(text: string): ParsedTransaction[] {
  const period = extractStatementPeriod(text);
  if (!period) return [];
  const lines = text.split(/\r?\n/);
  const transactions: ParsedTransaction[] = [];
  for (let index = 0; index < lines.length; index++) {
    const tx = pdfTransactionAt(lines, index, period);
    if (tx) transactions.push(tx);
  }
  return transactions;
}

function scannedPdfText(filePath: string): string {
  const tempRoot = path.resolve(os.tmpdir());
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "lashkirja-statement-"));
  const resolvedTempDir = path.resolve(tempDir);
  if (
    resolvedTempDir === tempRoot ||
    !resolvedTempDir.startsWith(`${tempRoot}${path.sep}lashkirja-statement-`)
  ) {
    throw new StatementParseError("pdf", "TEMP_DIR_FAILED", "PDF-OCR:n väliaikaishakemisto ei ole turvallinen");
  }
  try {
    const prefix = path.join(resolvedTempDir, "page");
    execFileSync(
      "pdftoppm",
      [
        "-f",
        "1",
        "-l",
        "8",
        "-r",
        "160",
        "-jpeg",
        "-jpegopt",
        "quality=80",
        filePath,
        prefix,
      ],
      {
        timeout: 45_000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const images = fs
      .readdirSync(resolvedTempDir)
      .filter((name) => /^page-\d+\.jpg$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (images.length === 0 || images.length > 8) {
      throw new StatementParseError("pdf", "PDF_RENDER_FAILED", "Skannatun PDF:n sivuja ei voitu lukea");
    }
    let text = "";
    for (const image of images) {
      const imagePath = path.join(resolvedTempDir, image);
      const imageStat = fs.statSync(imagePath);
      if (!imageStat.isFile() || imageStat.size > 15 * 1024 * 1024) {
        throw new StatementParseError("pdf", "PDF_PAGE_TOO_LARGE", "Skannatun PDF:n sivu on liian suuri");
      }
      text += execFileSync(
        "tesseract",
        [imagePath, "stdout", "-l", "fin+eng", "--psm", "6"],
        {
          timeout: 20_000,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }
      );
      text += "\n";
      if (Buffer.byteLength(text, "utf8") > MAX_TEXT_OUTPUT_BYTES) {
        throw new StatementParseError("pdf", "OCR_OUTPUT_TOO_LARGE", "PDF-OCR tuotti liikaa tekstiä");
      }
    }
    return text;
  } catch (error) {
    if (error instanceof StatementParseError) throw error;
    // Also the case where the reader program is missing on the server: the
    // owner gets the way forward, the cause goes to the log.
    console.warn("Scanned PDF read failed:", error instanceof Error ? error.message : error);
    throw new StatementParseError(
      "pdf",
      "SCANNED_PDF_OCR_FAILED",
      "Skannattua PDF-tiliotetta ei voitu lukea. Lataa pankin XML-, XLSX- tai CSV-tiedosto."
    );
  } finally {
    fs.rmSync(resolvedTempDir, { recursive: true, force: false });
  }
}

export async function parsePDFStatement(filePath: string): Promise<ParsedTransaction[]> {
  const buffer = readBoundedFile(filePath, "pdf");
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new StatementParseError("pdf", "INVALID_PDF", "Tiedosto ei ole kelvollinen PDF");
  }

  let layoutText = "";
  let plainText = "";
  try {
    layoutText = execFileSync("pdftotext", ["-layout", filePath, "-"], {
      timeout: 30_000,
      maxBuffer: MAX_TEXT_OUTPUT_BYTES,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    plainText = execFileSync("pdftotext", [filePath, "-"], {
      timeout: 30_000,
      maxBuffer: MAX_TEXT_OUTPUT_BYTES,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    try {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buffer });
      try {
        plainText = (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    } catch (error) {
      console.warn("PDF text extraction failed:", error instanceof Error ? error.message : error);
      throw new StatementParseError(
        "pdf",
        "PDF_TEXT_EXTRACTION_FAILED",
        "PDF-tiedoston tekstiä ei voitu lukea. Lataa pankin XML-, XLSX- tai CSV-tiedosto."
      );
    }
  }

  const layoutTransactions = parseFinnishBankStatementLayout(layoutText);
  if (layoutTransactions.length > 0) {
    const expected = pdfSummary(layoutText);
    if (expected) {
      const actualNet = layoutTransactions.reduce((sum, tx) => sum + tx.amount, 0);
      if (
        expected.count !== layoutTransactions.length ||
        Math.abs(expected.net - actualNet) > 0.01
      ) {
        throw new StatementParseError(
          "pdf",
          "PDF_RECONCILIATION_FAILED",
          `PDF-tiliotteen tarkistus epäonnistui: odotettiin ${expected.count} tapahtumaa / ${expected.net.toFixed(2)} €, löytyi ${layoutTransactions.length} / ${actualNet.toFixed(2)} €`
        );
      }
    }
    return finish("pdf", layoutTransactions);
  }

  const holviTransactions = parseHolviTilioteLayout(layoutText);
  if (holviTransactions.length > 0) {
    return finish("pdf", holviTransactions);
  }

  const plainTransactions = parseBankStatementText(plainText);
  if (plainTransactions.length > 0) return finish("pdf", plainTransactions);

  const ocrText = scannedPdfText(filePath);
  const ocrLayoutTransactions = parseFinnishBankStatementLayout(ocrText);
  if (ocrLayoutTransactions.length > 0) {
    return finish("pdf", ocrLayoutTransactions);
  }
  const ocrHolviTransactions = parseHolviTilioteLayout(ocrText);
  if (ocrHolviTransactions.length > 0) {
    return finish("pdf", ocrHolviTransactions);
  }
  const ocrTransactions = parseBankStatementText(ocrText);
  if (ocrTransactions.length === 0) {
    throw new StatementParseError(
      "pdf",
      "SCANNED_PDF_UNSUPPORTED",
      "Skannatun PDF-tiliotteen tapahtumia ei voitu tunnistaa. Lataa pankin XML-, XLSX- tai CSV-tiedosto."
    );
  }
  return finish("pdf", ocrTransactions);
}

export function parseBankStatementText(text: string): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = [];
  const lines = text.split(/\r?\n/);
  const txRegex =
    /(\d{1,2}[./]\d{1,2}[./]\d{2,4})\s+(.+?)\s+(-?[\d\s\u00a0]+[.,]\d{2})\s*$/;
  for (const line of lines) {
    const match = line.match(txRegex);
    if (!match) continue;
    const date = parseDateValue(match[1]);
    const amount = parseAmountValue(match[3]);
    if (!date || amount == null) continue;
    transactions.push({
      date,
      counterparty: match[2].trim(),
      amount,
      reference: null,
      message: null,
    });
  }
  return transactions;
}
