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

export interface EbGenericId {
  identification?: string | null;
  scheme_name?: string | null;
}

export interface EbAccountRef {
  iban?: string | null;
  other?: EbGenericId | null;
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
  all_account_ids?: EbGenericId[] | null;
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
  /**
   * The row's identity. With a bank reference it is `eb:<iban>:<reference>`;
   * without one it is a fingerprint of the normalised content, and
   * `withOccurrenceRefs` adds `~2`, `~3` ... for genuine identical twins.
   */
  bankRef: string;
  /** True when the bank supplied entry_reference or transaction_id. */
  stableRef: boolean;
  /** Which of several identical rows this is within one fetch (1 = first). */
  occurrence: number;
  /** Normalised content hash; also computable from a stored Transaction. */
  fingerprint: string;
  /**
   * The key pre-fix syncs stored for this row (a hash of the raw strings), so a
   * row already in the database is recognised. Null when the bank gave a
   * reference, and for the second and later twins, which the old key collapsed.
   */
  legacyBankRef: string | null;
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
  /**
   * "YYYY-MM-DD": the day the owner chose to fetch from, or, when nothing was
   * chosen (all the bank allows), the earliest day fetched for the accounts in
   * the books. Null when neither is known yet.
   */
  historyFrom: string | null;
  /** How many days back the bank gives transactions, when known. */
  historyLimitDays: number | null;
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

/** Trim, collapse inner whitespace, fold case: "Kahvi  ostos " equals "kahvi ostos". */
function normalizeText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

export interface FingerprintParts {
  iban: string;
  /** YYYY-MM-DD, or null for an undated row. */
  date: string | null;
  amountCents: number;
  reference: string | null;
  message: string | null;
  counterparty: string | null;
}

/**
 * Identity of a movement by what it is, not by how the bank spelled it: the
 * amount as integer cents, the day as an ISO date, and the free text collapsed
 * and case-folded. Works on a fetched row and on a stored Transaction alike.
 */
export function contentFingerprint(parts: FingerprintParts): string {
  return createHash("sha256")
    .update(
      [
        parts.iban,
        parts.date ?? "",
        String(parts.amountCents),
        normalizeText(parts.reference),
        normalizeText(parts.message),
        normalizeText(parts.counterparty),
      ].join("\n"),
      "utf8"
    )
    .digest("hex")
    .slice(0, 32);
}

function stableBankRef(iban: string, tx: EbTransaction): string | null {
  const stable = (tx.entry_reference || tx.transaction_id || "").trim();
  return stable ? `eb:${iban}:${stable}`.slice(0, 240) : null;
}

/** The pre-fix key: a hash of the raw strings. Kept only to recognise stored rows. */
function legacyFallbackRef(iban: string, tx: EbTransaction): string {
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

function txFingerprint(iban: string, tx: EbTransaction, amountCents: number, indicator: string | undefined): string {
  return contentFingerprint({
    iban,
    date: transactionDate(tx),
    amountCents,
    reference: clip(tx.reference_number, 80),
    message: remittance(tx.remittance_information),
    counterparty: counterpartyName(tx, indicator),
  });
}

function signedCents(tx: EbTransaction): { cents: number; indicator: string | undefined } | null {
  const rawAmount = tx.transaction_amount?.amount;
  if (!rawAmount) return null;
  const parsed = decimalToCents(rawAmount);
  if (parsed == null) return null;
  const indicator = tx.credit_debit_indicator?.trim().toUpperCase();
  const cents =
    indicator === "DBIT" ? -Math.abs(parsed) : indicator === "CRDT" ? Math.abs(parsed) : parsed;
  return { cents, indicator };
}

/** Prefix of a fingerprint-based ref; a bank reference never gets it from us. */
export const FINGERPRINT_REF_TAG = "fp-";

/**
 * The key of a movement: the bank's own reference when it gives one,
 * otherwise a fingerprint of the normalised content (first occurrence; see
 * `withOccurrenceRefs` for identical twins).
 */
export function bankRefFor(iban: string, tx: EbTransaction): string {
  const stable = stableBankRef(iban, tx);
  if (stable) return stable;
  const money = signedCents(tx);
  // An amount that cannot be read never reaches the database (the row is
  // dropped by mapBookedTransaction); keep a deterministic key for callers.
  if (!money) return legacyFallbackRef(iban, tx);
  return `eb:${iban}:${FINGERPRINT_REF_TAG}${txFingerprint(iban, tx, money.cents, money.indicator)}`;
}

/** True for a key built from content, false for a bank reference. */
export function isFingerprintRef(bankRef: string): boolean {
  const tail = bankRef.split(":").slice(2).join(":");
  return /^(?:fp-)?[0-9a-f]{32}(?:~\d+)?$/.test(tail);
}

/**
 * Makes the refs of reference-less rows unique within one fetch: the n-th
 * identical row gets `~n` (n >= 2). The first keeps the plain key, so it is the
 * same on every re-sync, and genuine twins are kept instead of collapsing.
 */
export function withOccurrenceRefs(rows: MappedBankTransaction[]): MappedBankTransaction[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    if (row.stableRef) return row;
    const occurrence = (seen.get(row.fingerprint) ?? 0) + 1;
    seen.set(row.fingerprint, occurrence);
    if (occurrence === 1) return row;
    return {
      ...row,
      occurrence,
      bankRef: `${row.bankRef.split("~")[0]}~${occurrence}`,
      legacyBankRef: null,
    };
  });
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
  const money = signedCents(tx);
  if (!money) return null;
  const { cents: amountCents, indicator } = money;
  const stable = stableBankRef(iban, tx);

  return {
    date: transactionDate(tx),
    counterparty: counterpartyName(tx, indicator),
    amountCents,
    reference: clip(tx.reference_number, 80),
    message: remittance(tx.remittance_information),
    bankRef: bankRefFor(iban, tx),
    stableRef: stable !== null,
    occurrence: 1,
    fingerprint: txFingerprint(iban, tx, amountCents, indicator),
    legacyBankRef: stable ? null : legacyFallbackRef(iban, tx),
    iban,
  };
}

/**
 * The account's IBAN wherever the bank put it: `account_id.iban`, or an IBAN-shaped
 * `account_id.other` / `all_account_ids` entry. Holvi's consent (2026-10-08) came back with
 * no `account_id.iban`, and the connection was refused with "Pankki ei palauttanut IBAN-tiliä".
 */
export function sessionAccountIban(account: EbSessionAccount): string | null {
  const direct = normalizeIban(account.account_id?.iban);
  if (direct) return direct;
  const others = [account.account_id?.other, ...(account.all_account_ids ?? [])];
  for (const id of others) {
    const scheme = id?.scheme_name?.trim().toUpperCase();
    if (scheme && scheme !== "IBAN") continue;
    const iban = normalizeIban(id?.identification);
    if (iban) return iban;
  }
  return null;
}

/** What a session's accounts looked like, without any account number: for the log. */
export function describeSessionAccounts(accounts: EbSessionAccount[]): string {
  return JSON.stringify(
    accounts.map((account) => ({
      keys: Object.keys(account).sort(),
      uid: Boolean(account.uid),
      iban: Boolean(account.account_id?.iban),
      other: account.account_id?.other?.scheme_name ?? (account.account_id?.other ? "?" : null),
      all: (account.all_account_ids ?? []).map((id) => id.scheme_name ?? "?"),
    }))
  );
}

export function sessionAccountsForStorage(
  accounts: EbSessionAccount[],
  userId: string,
  connectionId: string
): StoredBankAccount[] {
  const seen = new Set<string>();
  const rows: StoredBankAccount[] = [];
  for (const account of accounts) {
    const iban = sessionAccountIban(account);
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
  historyFrom?: string | null;
  historyLimitDays?: number | null;
  accounts: Array<{
    id: string;
    iban: string;
    label: string | null;
    currency: string;
    inScope: boolean;
    balanceCents: number | null;
    balanceAt: Date | null;
    historyFrom?: string | null;
  }>;
}): PublicBankConnection {
  const fetchedFrom = row.accounts
    .filter((account) => account.inScope && account.historyFrom)
    .map((account) => account.historyFrom as string)
    .sort()[0];
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
    historyFrom: row.historyFrom ?? fetchedFrom ?? null,
    historyLimitDays: row.historyLimitDays ?? null,
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
