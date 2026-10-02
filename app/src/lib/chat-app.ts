import type { ChatSource } from "./chat-turn";

/** Server-owned destinations: the model never constructs action URLs. */
export const CHAT_DESTINATIONS = [
  { id: "bank", label: "Yhdistä pankki", href: "/kirjanpito/pankkitilit?connect=1", description: "Connect a bank, choose bank accounts, import statements. The bank consent is confirmed by the user." },
  { id: "invoice", label: "Uusi lasku", href: "/laskut/uusi", description: "Create a sales invoice; choose customer and invoice rows." },
  { id: "seller", label: "Laskuttajan tiedot", href: "/asetukset/laskutus", description: "Set business name, business ID and invoice IBAN." },
  { id: "receipts", label: "Kuitit", href: "/kuitit", description: "Review uploaded receipts and their analysis." },
  { id: "transactions", label: "Tapahtumat", href: "/pankki/tapahtumat", description: "Review bank transactions and match receipts; matches require user confirmation." },
  { id: "vat", label: "ALV-ilmoitus", href: "/kirjanpito/alv", description: "View computed VAT and record filing/payment; the app does not file to OmaVero itself." },
  { id: "reports", label: "Raportit", href: "/raportit", description: "Financial reports and accounting exports." },
  { id: "settings", label: "Asetukset", href: "/asetukset", description: "Profile, business/VAT registration, email import and account security." },
] as const;

export const APP_GUIDE = CHAT_DESTINATIONS.map(item => `${item.label}: ${item.href} — ${item.description}`).join("\n");

export function suggestedChatActions(message: string): ChatSource[] {
  const text = message.toLocaleLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const ids: string[] = [];
  if (/pank|\bbank|banka/.test(text)) ids.push(/tapahtum|transaction|matching/.test(text) ? "transactions" : "bank");
  if (/laskuttaj|iban|business (?:details|id)|y-tunnus|fatura bilgiler/.test(text)) ids.push("seller");
  else if (/lasku|invoice|fatura/.test(text)) ids.push("invoice");
  if (/kuitt|receipt|fis|makbuz/.test(text)) ids.push("receipts");
  if (/\balv\b|\bvat\b|\bkdv\b/.test(text)) ids.push("vat");
  if (/raport|report|rapor/.test(text)) ids.push("reports");
  if (/asetus|settings|ayar/.test(text)) ids.push("settings");
  return CHAT_DESTINATIONS.filter(item => ids.includes(item.id)).slice(0, 3).map(({ label, href }) => ({ label, href, kind: "action" }));
}

export function asksToConnectBank(message: string): boolean {
  const text = message.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return /pank|\bbank|banka/.test(text) && /yhdist|liitt|kytke|connect|link|bagl|nerden|nereden/.test(text);
}
