import type { ChatSource } from "./chat-turn";

/**
 * Server-owned destinations: the model never constructs action URLs. Every
 * path here is one both the web app and the native app open
 * (ios-native/.../Format/AppLink.swift parses each of them).
 */
export const CHAT_DESTINATIONS = [
  { id: "bank", label: "Yhdistä pankki", href: "/kirjanpito/pankkitilit?connect=1", description: "Connect a bank, choose bank accounts, import statements. The bank consent is confirmed by the user." },
  { id: "bankAccounts", label: "Pankkiyhteys ja tilit", href: "/kirjanpito/pankkitilit", description: "Connected banks, bank accounts and their status; renew an expired bank consent." },
  { id: "bankHub", label: "Pankki", href: "/pankki", description: "Bank balances and the latest bank rows." },
  { id: "transactions", label: "Tapahtumat", href: "/pankki/tapahtumat", description: "Review bank transactions and match receipts; matches require user confirmation." },
  { id: "statements", label: "Tiliotteet", href: "/tiliotteet", description: "Imported bank statement files." },
  { id: "invoice", label: "Uusi lasku", href: "/laskut/uusi", description: "Create a sales invoice; choose customer and invoice rows." },
  { id: "invoices", label: "Laskut", href: "/laskut", description: "Sales invoices: drafts, awaiting payment, late and paid; send reminders and credit notes." },
  { id: "recurringInvoices", label: "Toistuvat laskut", href: "/toistuvat", description: "Recurring sales invoices that are created on a schedule." },
  { id: "customers", label: "Asiakkaat", href: "/asiakkaat", description: "Customers and their invoices." },
  { id: "purchaseInvoices", label: "Ostolaskut", href: "/kirjanpito/ostolaskut", description: "Purchase invoices (bills to pay) and, in the mobile app, recurring purchases; record payments." },
  { id: "receipts", label: "Kuitit", href: "/kuitit", description: "Review uploaded receipts and their analysis." },
  { id: "workQueue", label: "Huomioitavat", href: "/tyot", description: "Imports and fetches in progress, and the ones that failed and need fixing." },
  { id: "monthClose", label: "Kuukauden sulku", href: "/kirjanpito/kuukausi", description: "Close the month: what is still open before the month can be locked." },
  { id: "periods", label: "Suljetut kaudet", href: "/kirjanpito/kaudet", description: "Locked months; a locked month cannot be changed." },
  { id: "vat", label: "ALV-ilmoitus", href: "/kirjanpito/alv", description: "View computed VAT and record filing/payment; the app does not file to OmaVero itself." },
  { id: "reports", label: "Raportit", href: "/raportit", description: "Financial reports and accounting exports." },
  { id: "settings", label: "Asetukset", href: "/asetukset", description: "Profile, business/VAT registration, email import and account security." },
  { id: "seller", label: "Laskuttajan tiedot", href: "/asetukset/laskutus", description: "Set business name, business ID and invoice IBAN." },
  { id: "company", label: "Yritysmuoto ja ALV", href: "/asetukset/yritys", description: "Business form, VAT registration and VAT period." },
  { id: "profile", label: "Profiili", href: "/asetukset/profiili", description: "The owner's name and business profile." },
  { id: "email", label: "Sähköpostituonti", href: "/asetukset/sahkoposti", description: "Import receipts and bills from email." },
  { id: "privacy", label: "Tietosuoja", href: "/asetukset/tietosuoja", description: "Privacy, data export and account deletion." },
  { id: "help", label: "Ohje ja tuki", href: "/asetukset/ohje", description: "Help and support." },
] as const;

export type ChatDestinationId = (typeof CHAT_DESTINATIONS)[number]["id"];

export const APP_GUIDE = CHAT_DESTINATIONS.map(item => `${item.label}: ${item.href} — ${item.description}`).join("\n");

/** Lower case without diacritics: "eşleştir" → "eslestir", "İçe" → "ice". */
function fold(message: string): string {
  return message.replace(/İ/g, "i").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/ı/g, "i");
}

const CONNECT_WORDS = /yhdist(?!.*kuit)|liitt|kytke|connect|link|bagl|nerden|nereden|anslut|koppla/;

/**
 * The places a question is about, in Finnish, English, Turkish and Swedish; the
 * chips offered with the answer. At most three, in the order of CHAT_DESTINATIONS.
 */
export function suggestedChatActions(message: string): ChatSource[] {
  const text = fold(message);
  const ids = new Set<ChatDestinationId>();
  const matching = /kohdist|tasmay|\bmatch|eslestir|eslest|islem|matcha/.test(text);
  const statements = /tiliote|tiliottee|statement|ekstre|kontoutdrag/.test(text);
  if (/pank|\bbank|banka/.test(text)) {
    if (/tapahtum|transaction|matching|hareket/.test(text) || matching) ids.add("transactions");
    else if (statements) ids.add("statements");
    else if (CONNECT_WORDS.test(text)) ids.add("bank");
    else if (/tili(?!ote)|account|hesap|konto/.test(text) && !/saldo|balance|bakiye|rahaa|paljonko|ne kadar/.test(text)) ids.add("bankAccounts");
    else ids.add("bankHub");
  } else if (statements) ids.add("statements");
  if (matching) ids.add("transactions");
  const purchase = /ostolask|purchase invoice|\bbills?\b|alis fatura|gider fatura|leverantorsfaktur/.test(text);
  const recurring = /toistuv|recurring|tekrarlayan|duzenli fatura|aterkommande/.test(text);
  if (purchase) ids.add("purchaseInvoices");
  if (recurring && !purchase) ids.add("recurringInvoices");
  if (/laskuttaj|iban|business (?:details|id)|y-tunnus|fatura bilgiler/.test(text)) ids.add("seller");
  else if (!purchase && !recurring && /lasku|invoice|fatura|faktura/.test(text)) ids.add(/uusi|new|yeni|olustur|luo|tee\b|ny\b/.test(text) || !/laskut\b|invoices|faturalar/.test(text) ? "invoice" : "invoices");
  if (/kuitt|receipt|fis|makbuz|kvitto/.test(text) && !matching) ids.add("receipts");
  if (/\balv\b|\bvat\b|\bkdv\b|\bmoms/.test(text)) ids.add("vat");
  if (/tuont|tuoda|virhe|huomioitav|import|error|failed|ice aktar|hata|fel\b/.test(text) && !statements) ids.add("workQueue");
  if (/kuukauden sulku|kuun sulku|sulje(?:n)? kuu|suljen kuukau|sulkea kuukau|close the month|month[- ]end|month close|ay sonu|ay kapan|manadsbokslut|stang manaden/.test(text)) ids.add("monthClose");
  else if (/lukit|locked|suljetut kaudet|kilitli/.test(text)) ids.add("periods");
  if (/sahkopost|e-?mail|e-?posta|mejl|\bmail/.test(text)) ids.add("email");
  if (/asiaka|asiakkaa|customer|musteri|kund/.test(text)) ids.add("customers");
  if (/raport|report|rapor/.test(text)) ids.add("reports");
  if (/yritysmuoto|alv-rekister|alv-kau|business form|vat period|sirket tur|foretagsform/.test(text)) ids.add("company");
  if (/profiil|profile|profil/.test(text)) ids.add("profile");
  if (/tietosuoja|privacy|gizlilik|integritet/.test(text)) ids.add("privacy");
  if (/\bohje|help\b|\btuki\b|yardim|hjalp/.test(text)) ids.add("help");
  if (/asetus|settings|ayar|installning/.test(text) && ids.size === 0) ids.add("settings");
  return CHAT_DESTINATIONS.filter(item => ids.has(item.id)).slice(0, 3).map(({ label, href }) => ({ label, href, kind: "action" }));
}

export function asksToConnectBank(message: string): boolean {
  const text = message.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return /pank|\bbank|banka/.test(text) && /yhdist|liitt|kytke|connect|link|bagl|nerden|nereden/.test(text);
}
