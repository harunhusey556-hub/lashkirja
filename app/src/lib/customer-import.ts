/**
 * CSV preview for the customer register.
 *
 * Invalid rows are reported and never inserted. A header row is optional.
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

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"').trim();
  }
  return trimmed;
}

/** Splits one CSV line on commas, keeping quoted commas together. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
        current += char;
      }
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(unquote(current));
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(unquote(current));
  return cells;
}

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
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const first = splitCsvLine(lines[0]);
  const columns = headerIndex(first);
  const dataLines = columns ? lines.slice(1) : lines;
  const index = columns ?? { name: 0, email: 1, phone: 2, businessId: 3 };
  const seen = new Set<string>();
  const rows: CustomerCsvRow[] = [];

  dataLines.forEach((line, offset) => {
    const cells = splitCsvLine(line);
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
