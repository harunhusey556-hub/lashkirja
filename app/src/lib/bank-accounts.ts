/**
 * Bank account persistence and the reporting shapes the UI consumes.
 *
 * All money crosses the API boundary as euros (numbers), while the database
 * keeps integer cents. Conversion happens here so no route has to remember.
 */
import { prisma } from "./db";
import { centsToEuros, eurosToCents } from "./money";
import { isValidIban, normalizeIban } from "./iban";
import {
  buildRollforward,
  monthKey,
  totalPosition,
  type MonthlyBalanceRow,
  type RollforwardResult,
} from "./bank-balances";
import { AppError, NotFoundError, ValidationError } from "./api-errors";
import { assertMonthOpen } from "./period-lock";

export interface BankAccountInput {
  name: string;
  bankName?: string | null;
  iban?: string | null;
  bic?: string | null;
  currency?: string;
  openingBalance: number; // euros
  openingDate: string; // YYYY-MM-DD
  isDefault?: boolean;
}

export interface PublicBankAccount {
  id: string;
  name: string;
  bankName: string | null;
  iban: string | null;
  bic: string | null;
  currency: string;
  openingBalance: number;
  openingDate: string;
  isDefault: boolean;
  archivedAt: string | null;
}

export interface BankAccountWithPosition extends PublicBankAccount {
  currentBalance: number;
  lastReconciledMonth: string | null;
  mismatchCount: number;
  unreportedCount: number;
  statementCount: number;
  transactionCount: number;
}

type BankAccountRow = {
  id: string;
  name: string;
  bankName: string | null;
  iban: string | null;
  bic: string | null;
  currency: string;
  openingBalanceCents: number;
  openingDate: Date;
  isDefault: boolean;
  archivedAt: Date | null;
};

export function toPublicBankAccount(row: BankAccountRow): PublicBankAccount {
  return {
    id: row.id,
    name: row.name,
    bankName: row.bankName,
    iban: row.iban,
    bic: row.bic,
    currency: row.currency,
    openingBalance: centsToEuros(row.openingBalanceCents),
    openingDate: row.openingDate.toISOString().slice(0, 10),
    isDefault: row.isDefault,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

/** Normalises and validates an IBAN, or returns null for an empty value. */
export function prepareIban(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = normalizeIban(value);
  if (!normalized) return null;
  if (!isValidIban(normalized)) {
    throw new ValidationError("IBAN ei ole kelvollinen (tarkistusnumero ei täsmää).");
  }
  return normalized;
}

/**
 * An account of this user already holding the IBAN, if any. An archived holder
 * is named, so the owner is never told only that "another account" has it.
 */
async function findIbanHolder(userId: string, iban: string | null, exceptId?: string) {
  if (!iban) return null;
  const where = { userId, iban, ...(exceptId ? { id: { not: exceptId } } : {}) };
  return (await prisma.bankAccount.findFirst({ where: { ...where, archivedAt: null } })) ?? prisma.bankAccount.findFirst({ where });
}

async function assertIbanFree(
  userId: string,
  iban: string | null,
  exceptId?: string
): Promise<void> {
  const holder = await findIbanHolder(userId, iban, exceptId);
  if (!holder) return;
  if (holder.archivedAt) {
    throw new AppError(
      `Tämä IBAN kuuluu arkistoituun tiliin "${holder.name}". Palauta se käyttöön Näytä arkistoidut -kohdasta.`,
      "IBAN_ARCHIVED",
      409,
      { accountId: holder.id, name: holder.name }
    );
  }
  throw new AppError("Tämä IBAN on jo lisätty toiselle tilille.", "IBAN_IN_USE", 409);
}

/**
 * Statements of this IBAN that no account has claimed yet (a bank sync that ran
 * before the account existed) become the account's. A statement the owner has
 * already filed under an account is never moved.
 */
export async function adoptStatementsByIban(
  userId: string,
  bankAccountId: string,
  iban: string | null
): Promise<number> {
  if (!iban) return 0;
  const result = await prisma.statement.updateMany({
    where: {
      userId,
      bankAccountId: null,
      OR: [{ checksum: { startsWith: `eb:${iban}:` } }, { transactions: { some: { userId, iban } } }],
    },
    data: { bankAccountId },
  });
  return result.count;
}

/** Only one account per user may be the default; flipping one clears the rest. */
async function clearOtherDefaults(userId: string, keepId: string): Promise<void> {
  await prisma.bankAccount.updateMany({
    where: { userId, id: { not: keepId }, isDefault: true },
    data: { isDefault: false },
  });
}

export async function createBankAccount(
  userId: string,
  input: BankAccountInput
): Promise<PublicBankAccount & { restored?: boolean }> {
  const iban = prepareIban(input.iban);
  const holder = await findIbanHolder(userId, iban);
  if (holder?.archivedAt) {
    // Adding the IBAN of an archived account brings that account back, with the
    // opening balance its statements are already counted against: a second
    // account for the same IBAN would split one account's history in two.
    const activeOthers = await prisma.bankAccount.count({ where: { userId, archivedAt: null } });
    const restored = await prisma.bankAccount.update({
      where: { id: holder.id },
      data: { archivedAt: null, ...(activeOthers === 0 ? { isDefault: true } : {}) },
    });
    await adoptStatementsByIban(userId, restored.id, iban);
    return { ...toPublicBankAccount(restored), restored: true };
  }
  await assertIbanFree(userId, iban);

  const existingCount = await prisma.bankAccount.count({ where: { userId } });
  const created = await prisma.bankAccount.create({
    data: {
      userId,
      name: input.name.trim(),
      bankName: input.bankName?.trim() || null,
      iban,
      bic: input.bic?.trim().toUpperCase() || null,
      currency: (input.currency || "EUR").toUpperCase(),
      openingBalanceCents: eurosToCents(input.openingBalance),
      openingDate: new Date(`${input.openingDate}T00:00:00.000Z`),
      // The first account a user creates is the default, so uploads have
      // somewhere to land without an extra decision.
      isDefault: input.isDefault ?? existingCount === 0,
    },
  });

  if (created.isDefault) await clearOtherDefaults(userId, created.id);
  await adoptStatementsByIban(userId, created.id, iban);
  return toPublicBankAccount(created);
}

export async function updateBankAccount(
  userId: string,
  id: string,
  input: Partial<BankAccountInput> & { archived?: boolean }
): Promise<PublicBankAccount> {
  const existing = await prisma.bankAccount.findFirst({ where: { id, userId } });
  if (!existing) throw new NotFoundError("Pankkitiliä ei löytynyt.");

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.bankName !== undefined) data.bankName = input.bankName?.trim() || null;
  if (input.bic !== undefined) data.bic = input.bic?.trim().toUpperCase() || null;
  if (input.currency !== undefined) data.currency = input.currency.toUpperCase();
  if (input.openingBalance !== undefined) {
    data.openingBalanceCents = eurosToCents(input.openingBalance);
  }
  if (input.openingDate !== undefined) {
    data.openingDate = new Date(`${input.openingDate}T00:00:00.000Z`);
  }
  if (input.iban !== undefined) {
    const iban = prepareIban(input.iban);
    await assertIbanFree(userId, iban, id);
    data.iban = iban;
  }
  if (input.isDefault !== undefined) data.isDefault = input.isDefault;
  if (input.archived !== undefined) {
    data.archivedAt = input.archived ? new Date() : null;
    // An archived account must not stay the default target for new uploads.
    if (input.archived) data.isDefault = false;
  }

  const updated = await prisma.bankAccount.update({ where: { id }, data });
  if (updated.isDefault) await clearOtherDefaults(userId, id);
  // An account with a new IBAN, or one that is back in use, claims the bank
  // statements of that IBAN that nobody has claimed.
  if (!updated.archivedAt && (input.iban !== undefined || input.archived === false)) {
    await adoptStatementsByIban(userId, id, updated.iban);
  }
  return toPublicBankAccount(updated);
}

export interface DeleteOutcome {
  deleted: boolean;
  archived: boolean;
  statementCount: number;
}

/**
 * Deleting an account that still owns statements would orphan bookkeeping
 * evidence, so that case archives instead. Empty accounts are removed.
 */
export async function removeBankAccount(
  userId: string,
  id: string
): Promise<DeleteOutcome> {
  const existing = await prisma.bankAccount.findFirst({ where: { id, userId } });
  if (!existing) throw new NotFoundError("Pankkitiliä ei löytynyt.");

  const statementCount = await prisma.statement.count({ where: { bankAccountId: id } });
  if (statementCount > 0) {
    await prisma.bankAccount.update({
      where: { id },
      data: { archivedAt: new Date(), isDefault: false },
    });
    return { deleted: false, archived: true, statementCount };
  }

  await prisma.bankAccount.delete({ where: { id } });
  return { deleted: true, archived: false, statementCount: 0 };
}

async function loadAccountTransactions(bankAccountId: string) {
  return prisma.transaction.findMany({
    where: { statement: { bankAccountId } },
    select: { date: true, amountCents: true },
    orderBy: { date: "asc" },
  });
}

async function loadReportedBalances(bankAccountId: string) {
  const rows = await prisma.monthlyBalance.findMany({
    where: { bankAccountId },
    orderBy: { month: "asc" },
  });
  return rows.map((row) => ({
    month: row.month,
    closingBalanceCents: row.closingBalanceCents,
    source: row.source,
  }));
}

export interface AccountRollforward {
  account: PublicBankAccount;
  months: Array<{
    month: string;
    opening: number;
    openingSource: MonthlyBalanceRow["openingSource"];
    income: number;
    expense: number;
    net: number;
    txCount: number;
    computedClosing: number;
    reportedClosing: number | null;
    difference: number | null;
    status: MonthlyBalanceRow["status"];
  }>;
  currentBalance: number;
  lastReconciledMonth: string | null;
  mismatchMonths: string[];
  unreportedMonths: string[];
  excluded: RollforwardResult["excluded"] & { preOpeningAmount: number };
}

export async function getAccountRollforward(
  userId: string,
  id: string,
  options: { throughMonth?: string } = {}
): Promise<AccountRollforward> {
  const account = await prisma.bankAccount.findFirst({ where: { id, userId } });
  if (!account) throw new NotFoundError("Pankkitiliä ei löytynyt.");

  const [transactions, reported] = await Promise.all([
    loadAccountTransactions(id),
    loadReportedBalances(id),
  ]);

  const result = buildRollforward(
    { openingBalanceCents: account.openingBalanceCents, openingDate: account.openingDate },
    transactions,
    reported,
    { throughMonth: options.throughMonth ?? monthKey(new Date()) }
  );

  return {
    account: toPublicBankAccount(account),
    months: result.months.map((row) => ({
      month: row.month,
      opening: centsToEuros(row.openingCents),
      openingSource: row.openingSource,
      income: centsToEuros(row.incomeCents),
      expense: centsToEuros(row.expenseCents),
      net: centsToEuros(row.netCents),
      txCount: row.txCount,
      computedClosing: centsToEuros(row.computedClosingCents),
      reportedClosing:
        row.reportedClosingCents === null ? null : centsToEuros(row.reportedClosingCents),
      difference: row.differenceCents === null ? null : centsToEuros(row.differenceCents),
      status: row.status,
    })),
    currentBalance: centsToEuros(result.currentBalanceCents),
    lastReconciledMonth: result.lastReconciledMonth,
    mismatchMonths: result.mismatchMonths,
    unreportedMonths: result.unreportedMonths,
    excluded: {
      ...result.excluded,
      preOpeningAmount: centsToEuros(result.excluded.preOpeningAmountCents),
    },
  };
}

export interface BankOverview {
  accounts: BankAccountWithPosition[];
  totalBalance: number;
  totalAccounts: number;
  archivedCount: number;
  excludedCurrencies: string[];
  needsAttention: number;
}

export async function getBankOverview(
  userId: string,
  options: { includeArchived?: boolean } = {}
): Promise<BankOverview> {
  const [accounts, archivedCount] = await Promise.all([
    prisma.bankAccount.findMany({
      where: { userId, ...(options.includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
    prisma.bankAccount.count({ where: { userId, archivedAt: { not: null } } }),
  ]);

  const through = monthKey(new Date());
  const positions: BankAccountWithPosition[] = [];

  for (const account of accounts) {
    const [transactions, reported, statementCount] = await Promise.all([
      loadAccountTransactions(account.id),
      loadReportedBalances(account.id),
      prisma.statement.count({ where: { bankAccountId: account.id } }),
    ]);
    const result = buildRollforward(
      { openingBalanceCents: account.openingBalanceCents, openingDate: account.openingDate },
      transactions,
      reported,
      { throughMonth: through }
    );
    positions.push({
      ...toPublicBankAccount(account),
      currentBalance: centsToEuros(result.currentBalanceCents),
      lastReconciledMonth: result.lastReconciledMonth,
      mismatchCount: result.mismatchMonths.length,
      unreportedCount: result.unreportedMonths.length,
      statementCount,
      transactionCount: transactions.length,
    });
  }

  const total = totalPosition(
    positions
      .filter((position) => !position.archivedAt)
      .map((position) => ({
        bankAccountId: position.id,
        name: position.name,
        currency: position.currency,
        balanceCents: eurosToCents(position.currentBalance),
        status: "unreported" as const,
      }))
  );

  return {
    accounts: positions,
    totalBalance: centsToEuros(total.totalCents),
    totalAccounts: total.includedAccounts,
    archivedCount,
    excludedCurrencies: total.excludedCurrencies,
    needsAttention: positions.filter((p) => !p.archivedAt && p.mismatchCount > 0).length,
  };
}

export async function upsertMonthlyBalance(
  userId: string,
  bankAccountId: string,
  input: { month: string; closingBalance: number; source?: string; note?: string | null }
): Promise<{ month: string; closingBalance: number; source: string; note: string | null }> {
  const account = await prisma.bankAccount.findFirst({
    where: { id: bankAccountId, userId },
    select: { id: true, openingDate: true },
  });
  if (!account) throw new NotFoundError("Pankkitiliä ei löytynyt.");

  await assertMonthOpen(userId, input.month);

  if (input.month < monthKey(account.openingDate)) {
    throw new ValidationError(
      "Kuukausi on ennen tilin avauspäivää, joten saldoa ei voi kirjata."
    );
  }

  const closingBalanceCents = eurosToCents(input.closingBalance);
  const row = await prisma.monthlyBalance.upsert({
    where: { bankAccountId_month: { bankAccountId, month: input.month } },
    create: {
      bankAccountId,
      month: input.month,
      closingBalanceCents,
      source: input.source ?? "manual",
      note: input.note ?? null,
    },
    update: {
      closingBalanceCents,
      source: input.source ?? "manual",
      note: input.note ?? null,
    },
  });

  return {
    month: row.month,
    closingBalance: centsToEuros(row.closingBalanceCents),
    source: row.source,
    note: row.note,
  };
}

export async function deleteMonthlyBalance(
  userId: string,
  bankAccountId: string,
  month: string
): Promise<void> {
  const account = await prisma.bankAccount.findFirst({
    where: { id: bankAccountId, userId },
    select: { id: true },
  });
  if (!account) throw new NotFoundError("Pankkitiliä ei löytynyt.");

  await assertMonthOpen(userId, month);

  const deleted = await prisma.monthlyBalance.deleteMany({
    where: { bankAccountId, month },
  });
  if (deleted.count === 0) throw new NotFoundError("Saldoa ei löytynyt.");
}

/** Attach a statement to an account (or detach with null). */
export async function assignStatementAccount(
  userId: string,
  statementId: string,
  bankAccountId: string | null
): Promise<void> {
  const statement = await prisma.statement.findFirst({
    where: { id: statementId, userId },
    select: { id: true },
  });
  if (!statement) throw new NotFoundError("Tiliotetta ei löytynyt.");

  if (bankAccountId) {
    const account = await prisma.bankAccount.findFirst({
      where: { id: bankAccountId, userId },
      select: { id: true },
    });
    if (!account) throw new NotFoundError("Pankkitiliä ei löytynyt.");
  }

  await prisma.statement.update({
    where: { id: statementId },
    data: { bankAccountId },
  });
}

/** The archived account that owns an IBAN, when no active account does (M1-4). */
export async function archivedAccountForIban(
  userId: string,
  ibanInput: string | null | undefined
): Promise<{ id: string; name: string } | null> {
  const iban = ibanInput ? normalizeIban(ibanInput) : null;
  if (!iban || !isValidIban(iban)) return null;
  const holders = await prisma.bankAccount.findMany({
    where: { userId, iban },
    select: { id: true, name: true, archivedAt: true },
  });
  if (holders.some((holder) => holder.archivedAt === null)) return null;
  const archived = holders.find((holder) => holder.archivedAt !== null);
  return archived ? { id: archived.id, name: archived.name } : null;
}

/** Said when a file was left without an account because its own account is archived. */
export function archivedAccountImportNotice(accountName: string): string {
  return `Tiliote jätettiin ilman tiliä, koska se kuuluu arkistoituun tiliin ${accountName}. Palauta tili Pankki-sivulta tai valitse tiliotteelle tili.`;
}

/**
 * Pick the account a freshly uploaded statement belongs to: an IBAN seen in
 * the file wins, otherwise the default account, otherwise nothing. A file whose
 * own IBAN belongs only to an archived account is not guessed onto another
 * account (that would add its rows to the wrong balance): it stays without an
 * account until the owner restores the account or picks one.
 */
export async function resolveAccountForImport(
  userId: string,
  hints: { iban?: string | null } = {}
): Promise<string | null> {
  const iban = hints.iban ? normalizeIban(hints.iban) : null;
  if (iban && isValidIban(iban)) {
    // An archived account is out of use: a file is never filed under it by
    // detection. An IBAN found in the file is also only a hint (see
    // extractOwnIban), so it decides only when it is the file's own account.
    const byIban = await prisma.bankAccount.findFirst({
      where: { userId, iban, archivedAt: null },
      select: { id: true },
    });
    if (byIban) return byIban.id;
    if (await archivedAccountForIban(userId, iban)) return null;
  }
  const fallback = await prisma.bankAccount.findFirst({
    where: { userId, archivedAt: null },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true },
  });
  return fallback?.id ?? null;
}
