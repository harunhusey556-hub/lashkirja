/**
 * "Hoidettu automaattisesti" on Koti: what the app did for the owner in the
 * last 7 days, counted from real records only. The counts come from the
 * dashboard API; this file turns them into the parts, the sentences and the
 * place the card opens. Nothing is estimated and nothing is invented.
 */

export type HandledKind = "email_receipt" | "reference_payment" | "recurring_invoice";

export interface HandledPart {
  kind: HandledKind;
  count: number;
  label: string;
}

export interface Handled {
  count: number;
  parts: HandledPart[];
}

export interface HandledCounts {
  emailReceipts: number;
  referencePayments: number;
  recurringInvoices: number;
}

function clean(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function label(kind: HandledKind, count: number): string {
  const one = count === 1;
  switch (kind) {
    case "email_receipt":
      return `${count} ${one ? "kuitti" : "kuittia"} sähköpostista`;
    case "reference_payment":
      return `${count} ${one ? "maksu" : "maksua"} kohdistettu viitenumerolla`;
    case "recurring_invoice":
      return `${count} ${one ? "toistuva lasku" : "toistuvaa laskua"} luotu`;
  }
}

/** Parts with a count, the biggest first; the total is their sum. */
export function summariseHandled(counts: HandledCounts): Handled {
  const order: Array<[HandledKind, number]> = [
    ["email_receipt", clean(counts.emailReceipts)],
    ["reference_payment", clean(counts.referencePayments)],
    ["recurring_invoice", clean(counts.recurringInvoices)],
  ];
  const parts = order
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({ kind, count, label: label(kind, count) }))
    .sort((a, b) => b.count - a.count);
  return { count: parts.reduce((sum, part) => sum + part.count, 0), parts };
}

/** "14 tapahtumaa tällä viikolla". */
export function handledTitle(count: number): string {
  return `${count} ${count === 1 ? "tapahtuma" : "tapahtumaa"} tällä viikolla`;
}

/** "12 kuittia sähköpostista ja 2 maksua kohdistettu viitenumerolla". */
export function handledDetail(parts: readonly HandledPart[]): string {
  const labels = parts.map((part) => part.label);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} ja ${labels[labels.length - 1]}`;
}

/** The list that holds the biggest part. */
export function handledHref(parts: readonly HandledPart[]): string {
  switch (parts[0]?.kind) {
    case "reference_payment":
      return "/pankki/tapahtumat";
    case "recurring_invoice":
      return "/toistuvat";
    default:
      return "/kuitit";
  }
}
