import { prisma } from "./db";

export const CHAT_SEARCH_LIMIT = 20;
export interface ChatSearch { invalidDate?: boolean; from?: string; until?: string; customer?: string; invoiceNumber?: number; }
function isoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
/** Parse explicit filters only; never execute SQL, model code or owner IDs. */
export function parseChatSearch(message: string, now = new Date()): ChatSearch {
  const result: ChatSearch = {};
  const dates = message.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
  if (dates.length && dates.every(isoDate) && dates.length <= 2 && (!dates[1] || dates[1] >= dates[0]!)) {
    result.from = dates[0];
    const last = new Date(dates[1] ?? dates[0]); last.setUTCDate(last.getUTCDate() + 1);
    result.until = last.toISOString().slice(0, 10);
  } else if (!dates.length) {
    const month = message.match(/\b(20\d{2})-(0[1-9]|1[0-2])\b/);
    if (month) {
      result.from = `${month[1]}-${month[2]}-01`;
      result.until = new Date(Date.UTC(Number(month[1]), Number(month[2]), 1)).toISOString().slice(0, 10);
    }
  }
  if (!result.from && !dates.length) {
    const text = message.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    const parts = new Intl.DateTimeFormat("en", { timeZone: "Europe/Helsinki", year: "numeric", month: "numeric" }).formatToParts(now);
    let year = Number(parts.find(part => part.type === "year")!.value);
    let month = Number(parts.find(part => part.type === "month")!.value) - 1;
    const previous = /viime kuu|viime kuun|last month|gecen ay/.test(text);
    const current = /taman kuu|tassa kuussa|this month|bu ay/.test(text);
    const names = ["tammikuu","helmikuu","maaliskuu","huhtikuu","toukokuu","kesakuu","heinakuu","elokuu","syyskuu","lokakuu","marraskuu","joulukuu"];
    const named = names.findIndex(name => new RegExp(`\\b${name.slice(0,-1)}(?:u|un|ussa)\\b`).test(text));
    if (previous || current || named >= 0) {
      if (previous) month -= 1;
      if (named >= 0) { month = named; year = Number(text.match(/\b20\d{2}\b/)?.[0] ?? year); }
      result.from = new Date(Date.UTC(year, month, 1)).toISOString().slice(0,10);
      result.until = new Date(Date.UTC(year, month + 1, 1)).toISOString().slice(0,10);
    }
  }
  if (/\b\d{4}-\d{2}(?:-\d{2})?\b/.test(message) && !result.from) result.invalidDate = true;
  const customer = message.match(/(?:asiakas|asiakkaan|customer|client|müşteri|musteri)\s*[:=]?\s*["“]([^"”]{1,120})["”]/iu);
  if (customer) result.customer = customer[1].trim();
  const invoice = message.match(/(?:lasku(?:n)?|invoice|fatura)\s*(?:numero|number|no\.?|#)?\s*[:#]?\s*(\d{1,9})(?![\d-])/iu);
  if (invoice && !/^20\d{2}-/.test(message.slice((invoice.index ?? 0) + invoice[0].length - invoice[1].length))) result.invoiceNumber = Number(invoice[1]);
  return result;
}

export async function searchChatRecords(userId: string, filter: ChatSearch) {
  const date = filter.from ? { gte: new Date(filter.from), lt: new Date(filter.until!) } : undefined;
  const invoiceWhere = { userId, ...(date ? { issueDate: date } : {}), ...(filter.customer ? { customer: { userId, name: { contains: filter.customer } } } : {}), ...(filter.invoiceNumber !== undefined ? { number: filter.invoiceNumber } : {}) };
  // Customer filters refer to the invoice customer, never to receipt vendors.
  const receiptWhere = { userId, ...(date ? { date } : {}) };
  const includeReceipts = !filter.customer && filter.invoiceNumber === undefined;
  const [invoices, invoiceMatches, receipts, receiptMatches] = await Promise.all([
    prisma.salesInvoice.findMany({ where: invoiceWhere, select: { id: true, number: true, status: true, currency: true, grossCents: true, issueDate: true, dueDate: true, customer: { select: { name: true } } }, orderBy: [{ issueDate: "desc" }, { id: "desc" }], take: CHAT_SEARCH_LIMIT }),
    prisma.salesInvoice.count({ where: invoiceWhere }),
    includeReceipts ? prisma.receipt.findMany({ where: receiptWhere, select: { id: true, vendor: true, date: true, totalAmountCents: true, reviewStatus: true }, orderBy: [{ date: "desc" }, { id: "desc" }], take: CHAT_SEARCH_LIMIT }) : [],
    includeReceipts ? prisma.receipt.count({ where: receiptWhere }) : 0,
  ]);
  return { filter, invoices, receipts, invoiceMatches, receiptMatches, truncated: invoiceMatches > invoices.length || receiptMatches > receipts.length };
}
