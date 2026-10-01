/**
 * Finnish, field-naming text for a failed zod parse (F64).
 *
 * The API answers `{ error: { code, message, details } }` where `details` is a
 * list of `{ path, field, message }`: the form can put each message at its
 * field, and the sentence names the field and the limit instead of zod's English.
 */
import type { ZodError } from "zod";

export interface FieldIssue {
  /** Dotted path, e.g. "vatDetails.0.amount". */
  path: string;
  /** The first path segment that is a name, e.g. "vendor". */
  field: string;
  message: string;
}

const FIELD_LABELS: Record<string, string> = {
  vendor: "Myyjä",
  date: "Päivämäärä",
  totalAmount: "Summa",
  amount: "Summa",
  category: "Luokka",
  notes: "Selite",
  reference: "Viitenumero",
  invoiceNumber: "Laskun numero",
  vatDetails: "ALV",
  businessName: "Toiminimi",
  businessId: "Y-tunnus",
  addressStreet: "Katuosoite",
  addressPostalCode: "Postinumero",
  addressCity: "Postitoimipaikka",
  phone: "Puhelinnumero",
  invoiceIban: "Tilinumero",
  invoiceBic: "BIC",
  invoiceTerms: "Maksuehdot",
  firstName: "Etunimi",
  lastName: "Sukunimi",
  name: "Nimi",
  email: "Sähköposti",
  contactPerson: "Yhteyshenkilö",
  supplierName: "Toimittaja",
  supplierBusinessId: "Toimittajan Y-tunnus",
  supplierIban: "Toimittajan tilinumero",
  grossAmount: "Summa",
  vatAmount: "ALV-summa",
  description: "Kuvaus",
  dueDate: "Eräpäivä",
  issueDate: "Laskun päivä",
  message: "Viesti",
  title: "Otsikko",
};

/** The default English text zod writes when a schema gave no message of its own. */
const DEFAULT_ENGLISH = /^(invalid|too big|too small|expected|required|unrecognized|input|string|number)/i;

function labelFor(path: PropertyKey[]): string {
  const named = path.filter((part): part is string => typeof part === "string");
  for (let i = named.length - 1; i >= 0; i -= 1) {
    const label = FIELD_LABELS[named[i]];
    if (label) return label;
  }
  return "";
}

function firstName(path: PropertyKey[]): string {
  const named = path.find((part): part is string => typeof part === "string");
  return named ?? "";
}

function sentence(label: string, rest: string, fallback: string): string {
  return label ? `${label} ${rest}` : fallback;
}

export function zodIssuesFi(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path as PropertyKey[];
    const label = labelFor(path);
    const raw = issue as unknown as {
      origin?: string;
      maximum?: number | bigint;
      minimum?: number | bigint;
    };
    let message: string;
    const own = issue.message ?? "";

    if (issue.code === "custom" || (own && !DEFAULT_ENGLISH.test(own))) {
      message = own;
    } else if (issue.code === "too_big" && raw.origin === "string") {
      message = sentence(label, `saa olla enintään ${raw.maximum} merkkiä`, `Teksti saa olla enintään ${raw.maximum} merkkiä`);
    } else if (issue.code === "too_big" && raw.origin === "array") {
      message = sentence(label, `saa sisältää enintään ${raw.maximum} riviä`, "Rivejä on liikaa");
    } else if (issue.code === "too_big") {
      message = sentence(label, "on liian suuri", "Arvo on liian suuri");
    } else if (issue.code === "too_small" && raw.origin === "string") {
      message =
        Number(raw.minimum) <= 1
          ? sentence(label, "puuttuu", "Pakollinen tieto puuttuu")
          : sentence(label, `on liian lyhyt (vähintään ${raw.minimum} merkkiä)`, "Teksti on liian lyhyt");
    } else if (issue.code === "too_small") {
      message = sentence(label, "on liian pieni", "Arvo on liian pieni");
    } else if (issue.code === "invalid_type" && /received (undefined|null)/i.test(own)) {
      message = sentence(label, "puuttuu", "Pakollinen tieto puuttuu");
    } else if (issue.code === "unrecognized_keys") {
      message = "Lomakkeella on tuntematon kenttä";
    } else {
      message = sentence(label, "on virheellinen", "Tieto on virheellinen");
    }
    return { path: path.map(String).join("."), field: firstName(path), message };
  });
}

/** The `error` object of a 400 answer for a failed parse. */
export function zodErrorBody(error: ZodError): { code: string; message: string; details: FieldIssue[] } {
  return { code: "VALIDATION_FAILED", message: "Tarkista lomakkeen tiedot", details: zodIssuesFi(error) };
}
