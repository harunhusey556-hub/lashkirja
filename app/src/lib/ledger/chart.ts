/**
 * Tilikartta: the accounts the derived ledger posts to (a subset of the usual
 * Finnish limited-company chart). Receipt categories map to expense accounts;
 * anything unknown goes to "Muut kulut" rather than disappearing.
 */

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface Account {
  code: string;
  name: string;
  type: AccountType;
}

export const ACCOUNTS = {
  bank: { code: "1910", name: "Pankkitili", type: "asset" },
  receivables: { code: "1700", name: "Myyntisaamiset", type: "asset" },
  inputVat: { code: "1763", name: "Arvonlisäverosaamiset (vähennettävä ALV)", type: "asset" },
  payables: { code: "2871", name: "Ostovelat", type: "liability" },
  outputVat: { code: "2939", name: "Arvonlisäverovelka", type: "liability" },
  /** A purchase with no bank row behind it: most often paid with the owner's own money. */
  suspense: { code: "2990", name: "Selvittelytili (maksettu muualta kuin yritystililtä)", type: "liability" },
  sales255: { code: "3000", name: "Myynti 25,5 %", type: "revenue" },
  sales135: { code: "3001", name: "Myynti 13,5 %", type: "revenue" },
  sales10: { code: "3002", name: "Myynti 10 %", type: "revenue" },
  sales0: { code: "3010", name: "Myynti 0 %", type: "revenue" },
  otherIncome: { code: "3900", name: "Muut tuotot", type: "revenue" },
  purchases: { code: "4000", name: "Aine-, tarvike- ja tavaraostot", type: "expense" },
  freight: { code: "4400", name: "Rahdit", type: "expense" },
  wages: { code: "5000", name: "Palkat", type: "expense" },
  rent: { code: "7100", name: "Toimitilavuokrat", type: "expense" },
  utilities: { code: "7110", name: "Sähkö ja vesi", type: "expense" },
  fuel: { code: "7310", name: "Ajoneuvojen polttoaineet", type: "expense" },
  travel: { code: "7500", name: "Matkakulut", type: "expense" },
  training: { code: "7600", name: "Koulutus", type: "expense" },
  software: { code: "7680", name: "ATK-ohjelmistot ja palvelut", type: "expense" },
  marketing: { code: "7700", name: "Markkinointikulut", type: "expense" },
  insurance: { code: "7800", name: "Vakuutukset", type: "expense" },
  bankFees: { code: "7900", name: "Pankkikulut", type: "expense" },
  otherTaxes: { code: "7990", name: "Muut verot ja maksut", type: "expense" },
  otherExpenses: { code: "7999", name: "Muut kulut", type: "expense" },
  interest: { code: "9440", name: "Korkokulut", type: "expense" },
} as const satisfies Record<string, Account>;

export type AccountKey = keyof typeof ACCOUNTS;

const CATEGORY_ACCOUNT: Record<string, AccountKey> = {
  tarvikkeet: "purchases",
  vuokra: "rent",
  vesi: "utilities",
  ohjelmistot: "software",
  polttoaine: "fuel",
  rahti: "freight",
  matkakulut: "travel",
  markkinointi: "marketing",
  koulutus: "training",
  vakuutus: "insurance",
  pankki: "bankFees",
  verot: "otherTaxes",
  kuntavero: "otherTaxes",
  rahoitus: "interest",
  palkka: "wages",
  muut: "otherExpenses",
};

export function expenseAccount(category: string | null | undefined): AccountKey {
  return CATEGORY_ACCOUNT[(category ?? "").trim().toLowerCase()] ?? "otherExpenses";
}

/** The revenue account of a VAT rate (percent); legacy rates share their successor's account. */
export function salesAccount(rate: number): AccountKey {
  if (rate === 25.5 || rate === 24) return "sales255";
  if (rate === 13.5 || rate === 14) return "sales135";
  if (rate === 10) return "sales10";
  return "sales0";
}

export function accountOf(key: AccountKey): Account {
  return ACCOUNTS[key];
}

/** Every account, by code, for reports that list accounts in chart order. */
export const ACCOUNTS_BY_CODE: ReadonlyMap<string, Account> = new Map(
  Object.values(ACCOUNTS).map((account) => [account.code, account as Account])
);
