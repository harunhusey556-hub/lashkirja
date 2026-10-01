/**
 * CSV preview for the customer register.
 *
 * Invalid rows are reported and never inserted. A header row is optional.
 * The separator (comma, semicolon or tab) is detected, because Finnish
 * Excel and Sheets write semicolons.
 */
import { isValidBusinessId, normalizeBusinessId } from "./finnish-reference";

export interface CustomerCsvRow {
  line: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  businessId: string | null;
  errors: string[];
}

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Picks the separator from the first non-empty line, ignoring quoted text. */
function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  let seenContent = false;
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      seenContent = true;
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (seenContent) break;
      continue;
    }
    if (!/\s/.test(char)) seenContent = true;
    if (!quoted && char in counts) counts[char] += 1;
  }
  let best = ",";
  for (const candidate of [";", "\t"]) {
    if (counts[candidate] > counts[best]) best = candidate;
  }
  return best;
}

/**
 * Parses the whole text as CSV (RFC 4180): quoted cells may contain the
 * separator, a line break or a doubled quote. Rows that are entirely empty
 * are dropped.
 */
export function parseCsvTable(text: string): string[][] {
  const input = text.replace(/^﻿/, "");
  const delimiter = detectDelimiter(input);
  const table: string[][] = [];
  let row: string[] = [];
  let current = "";
  let quoted = false;

  const endCell = () => {
    row.push(current.trim());
    current = "";
  };
  const endRow = () => {
    endCell();
    if (row.some((value) => value.length > 0)) table.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' && current.trim() === "") {
      quoted = true;
      current = "";
    } else if (char === delimiter) {
      endCell();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      endRow();
    } else {
      current += char;
    }
  }
  endRow();
  return table;
}

/** The file could not be read as a customer list at all. */
export class CustomerCsvFileError extends Error {}

const HEADER_WORDS = ["email", "sähköposti", "sahkoposti", "phone", "puhelin", "businessid", "y-tunnus", "ytunnus"];

function headerIndex(header: string[]): Record<string, number> | null {
  const normalized = header.map((cell) => cell.trim().toLowerCase());
  const nameAt = normalized.findIndex((cell) => cell === "nimi" || cell === "name");
  if (nameAt === -1) return null;
  const find = (...names: string[]) => normalized.findIndex((cell) => names.includes(cell));
  return {
    name: nameAt,
    email: find("email", "sähköposti", "sahkoposti"),
    phone: find("phone", "puhelin"),
    businessId: find("businessid", "y-tunnus", "ytunnus"),
  };
}

function cell(cells: string[], index: number): string {
  if (index < 0 || index >= cells.length) return "";
  return cells[index]?.trim() ?? "";
}

export function parseCustomerCsv(text: string): CustomerCsvRow[] {
  const table = parseCsvTable(text);
  if (table.length === 0) return [];

  const first = table[0];
  const columns = headerIndex(first);
  if (!columns && first.some((value) => HEADER_WORDS.includes(value.toLowerCase()))) {
    throw new CustomerCsvFileError(
      "Tiedostoa ei voitu lukea: otsikkoriviltä puuttuu Nimi-sarake. Tarkista erotin (, tai ;) ja otsikkorivi."
    );
  }
  const dataLines = columns ? table.slice(1) : table;
  const index = columns ?? { name: 0, email: 1, phone: 2, businessId: 3 };
  const seen = new Set<string>();
  const rows: CustomerCsvRow[] = [];

  dataLines.forEach((cells, offset) => {
    const name = cell(cells, index.name);
    const emailRaw = cell(cells, index.email);
    const phone = cell(cells, index.phone);
    const businessRaw = cell(cells, index.businessId);
    const errors: string[] = [];
    let email: string | null = null;
    let businessId: string | null = null;

    if (!name) errors.push("Nimi puuttuu.");
    if (emailRaw) {
      email = emailRaw.toLowerCase();
      if (!EMAIL.test(email)) errors.push("Sähköpostiosoite ei ole kelvollinen.");
    }
    if (businessRaw) {
      if (!isValidBusinessId(businessRaw)) {
        errors.push("Y-tunnus ei ole kelvollinen.");
      } else {
        businessId = normalizeBusinessId(businessRaw);
      }
    }
    const key = name.toLowerCase();
    if (name && seen.has(key)) errors.push("Sama nimi on tiedostossa jo aiemmin.");
    if (name) seen.add(key);

    rows.push({
      line: (columns ? 2 : 1) + offset,
      name: name || null,
      email,
      phone: phone || null,
      businessId,
      errors,
    });
  });

  return rows;
}
