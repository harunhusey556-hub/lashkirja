import { createHash } from "crypto";
import { isIsoCalendarDate } from "../finnish-numbers";
import { centsToEuros } from "../money";

const MAX_CENTS = 2_147_483_647;

export interface EbAmount {
  currency?: string | null;
  amount?: string | null;
}

export interface EbParty {
  name?: string | null;
}

export interface EbAccountRef {
  iban?: string | null;
}

export interface EbTransaction {
  entry_reference?: string | null;
  transaction_id?: string | null;
  transaction_amount?: EbAmount | null;
  creditor?: EbParty | null;
  debtor?: EbParty | null;
  creditor_account?: EbAccountRef | null;
  debtor_account?: EbAccountRef | null;
  credit_debit_indicator?: string | null;
  status?: string | null;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  reference_number?: string | null;
  remittance_information?: string[] | null;
}

export interface EbSessionAccount {
  uid?: string | null;
  name?: string | null;
  details?: string | null;
  product?: string | null;
  currency?: string | null;
  account_id?: EbAccountRef | null;
}

export interface EbBalance {
  balance_type?: string | null;
  balance_amount?: EbAmount | null;
}

export interface MappedBankTransaction {
  date: string | null;
  counterparty: string | null;
  amountCents: number;
  reference: string | null;
  message: string | null;
  bankRef: string;
  iban: string;
}

export interface StoredBankAccount {
  userId: string;
  connectionId: string;
  iban: string;
  label: string | null;
  currency: string;
  providerAccountUid: string;
  inScope: false;
}

export interface PublicBankAccount {
  id: string;
  iban: string;
  label: string | null;
  currency: string;
  inScope: boolean;
  balance: number | null;
  balanceAt: string | null;
}

export interface PublicBankConnection {
  id: string;
  aspspName: string;
  aspspCountry: string;
  aspspLogo: string | null;
  psuType: string;
  status: string;
  validUntil: string | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  accounts: PublicBankAccount[];
}

const BALANCE_PREFERENCE = ["CLBD", "ITAV", "CLAV", "XPCD", "FWAV"];

export function normalizeIban(value: string | null | undefined): string | null {
  if (!value) return null;
  const iban = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return null;
  return iban;
}

export function formatIbanDisplay(iban: string): string {
  return normalizeIban(iban)?.replace(/(.{4})/g, "$1 ").trim() ?? iban;
}

export function decimalToCents(amount: string): number | null {
  const trimmed = amount.trim().replace(/\s/g, "");
  if (!trimmed) return null;
  const normalized =
    trimmed.includes(",") && !trimmed.includes(".")
      ? trimmed.replace(",", ".")
      : trimmed.replace(/,/g, "");
  const match = normalized.match(/^([+-])?(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const whole = Number(match[2]);
  if (!Number.isSafeInteger(whole)) return null;
  const fraction = match[3] ?? "";
  const centsPart = Number((fraction + "00").slice(0, 2));
  const roundUp = fraction.length >= 3 && Number(fraction[2]) >= 5;
  let cents = sign * (whole * 100 + centsPart);
  if (roundUp) cents += sign;
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CENTS) return null;
  return cents;
}

export function bankRefFor(iban: string, tx: EbTransaction): string {
  const stable = (tx.entry_reference || tx.transaction_id || "").trim();
  if (stable) return `eb:${iban}:${stable}`.slice(0, 240);
  const digest = createHash("sha256")
    .update(
      [
        iban,
        tx.booking_date || "",
        tx.transaction_date || "",
        tx.transaction_amount?.amount || "",
        tx.credit_debit_indicator || "",
        tx.reference_number || "",
        (tx.remittance_information || []).join("|"),
        tx.creditor?.name || "",
        tx.debtor?.name || "",
      ].join("\n"),
      "utf8"
    )
    .digest("hex")
    .slice(0, 32);
  return `eb:${iban}:${digest}`;
}

/** BOOK rows only. Accounts without an IBAN are skipped. */
export function mapBookedTransaction(
  tx: EbTransaction,
  accountIban: string | null | undefined
): MappedBankTransaction | null {
  if (tx.status && tx.status !== "BOOK") return null;
  const iban = normalizeIban(accountIban);
  if (!iban) return null;
  const currency = tx.transaction_amount?.currency?.trim().toUpperCase();
  if (currency && currency !== "EUR") return null;
  const rawAmount = tx.transaction_amount?.amount;
  if (!rawAmount) return null;
  const parsed = decimalToCents(rawAmount);
  if (parsed == null) return null;
  const indicator = tx.credit_debit_indicator?.trim().toUpperCase();
  const amountCents =
    indicator === "DBIT" ? -Math.abs(parsed) : indicator === "CRDT" ? Math.abs(parsed) : parsed;

  return {
    date: transactionDate(tx),
    counterparty: counterpartyName(tx, indicator),
    amountCents,
    reference: clip(tx.reference_number, 80),
    message: remittance(tx.remittance_information),
    bankRef: bankRefFor(iban, tx),
    iban,
  };
}

export function sessionAccountsForStorage(
  accounts: EbSessionAccount[],
  userId: string,
  connectionId: string
): StoredBankAccount[] {
  const seen = new Set<string>();
  const rows: StoredBankAccount[] = [];
  for (const account of accounts) {
    const iban = normalizeIban(account.account_id?.iban);
    const uid = account.uid?.trim();
    if (!iban || !uid || seen.has(uid)) continue;
    seen.add(uid);
    rows.push({
      userId,
      connectionId,
      iban,
      label: clip(account.name, 120) || clip(account.details, 120) || clip(account.product, 120),
      currency: account.currency?.trim().toUpperCase() || "EUR",
      providerAccountUid: uid,
      inScope: false,
    });
  }
  return rows;
}

export function pickBookedBalance(
  balances: EbBalance[]
): { amountCents: number; currency: string } | null {
  const usable = balances.filter((balance) => {
    const currency = balance.balance_amount?.currency?.trim().toUpperCase() || "EUR";
    return currency === "EUR" && Boolean(balance.balance_amount?.amount);
  });
  if (usable.length === 0) return null;
  const ranked = [...usable].sort((a, b) => rankBalance(a.balance_type) - rankBalance(b.balance_type));
  const cents = decimalToCents(ranked[0].balance_amount?.amount || "");
  if (cents == null) return null;
  return { amountCents: cents, currency: "EUR" };
}

export function toPublicConnection(row: {
  id: string;
  aspspName: string;
  aspspCountry: string;
  aspspLogo: string | null;
  psuType: string;
  status: string;
  validUntil: Date | null;
  lastSyncAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  accounts: Array<{
    id: string;
    iban: string;
    label: string | null;
    currency: string;
    inScope: boolean;
    balanceCents: number | null;
    balanceAt: Date | null;
  }>;
}): PublicBankConnection {
  return {
    id: row.id,
    aspspName: row.aspspName,
    aspspCountry: row.aspspCountry,
    aspspLogo: row.aspspLogo,
    psuType: row.psuType,
    status: row.status,
    validUntil: row.validUntil?.toISOString() ?? null,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastError: row.lastError,
    accounts: row.accounts.map((account) => ({
      id: account.id,
      iban: formatIbanDisplay(account.iban),
      label: account.label,
      currency: account.currency,
      inScope: account.inScope,
      balance: account.balanceCents == null ? null : centsToEuros(account.balanceCents),
      balanceAt: account.balanceAt?.toISOString() ?? null,
    })),
  };
}

function transactionDate(tx: EbTransaction): string | null {
  for (const value of [tx.booking_date, tx.transaction_date, tx.value_date]) {
    if (!value) continue;
    const day = value.slice(0, 10);
    if (isIsoCalendarDate(day)) return day;
  }
  return null;
}

function counterpartyName(tx: EbTransaction, indicator: string | undefined): string | null {
  const creditor = clip(tx.creditor?.name, 180);
  const debtor = clip(tx.debtor?.name, 180);
  if (indicator === "DBIT") return creditor || debtor;
  if (indicator === "CRDT") return debtor || creditor;
  return creditor || debtor;
}

function remittance(lines: string[] | null | undefined): string | null {
  if (!lines?.length) return null;
  const text = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);
  return text || null;
}

function clip(value: string | null | undefined, max: number): string | null {
  const text = value?.trim();
  if (!text) return null;
  return text.slice(0, max);
}

function rankBalance(type: string | null | undefined): number {
  const index = BALANCE_PREFERENCE.indexOf(type || "");
  return index === -1 ? 99 : index;
}
