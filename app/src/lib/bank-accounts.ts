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

async function assertIbanFree(
  userId: string,
  iban: string | null,
  exceptId?: string
): Promise<void> {
  if (!iban) return;
  const existing = await prisma.bankAccount.findFirst({
    where: { userId, iban, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (existing) {
    throw new AppError("Tämä IBAN on jo lisätty toiselle tilille.", "IBAN_IN_USE", 409);
  }
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
): Promise<PublicBankAccount> {
  const iban = prepareIban(input.iban);
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
  excludedCurrencies: string[];
  needsAttention: number;
}

export async function getBankOverview(
  userId: string,
  options: { includeArchived?: boolean } = {}
): Promise<BankOverview> {
  const accounts = await prisma.bankAccount.findMany({
    where: { userId, ...(options.includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });

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

/**
 * Pick the account a freshly uploaded statement belongs to: an IBAN seen in
 * the file wins, otherwise the default account, otherwise nothing.
 */
export async function resolveAccountForImport(
  userId: string,
  hints: { iban?: string | null } = {}
): Promise<string | null> {
  const iban = hints.iban ? normalizeIban(hints.iban) : null;
  if (iban && isValidIban(iban)) {
    const byIban = await prisma.bankAccount.findFirst({
      where: { userId, iban },
      select: { id: true },
    });
    if (byIban) return byIban.id;
  }
  const fallback = await prisma.bankAccount.findFirst({
    where: { userId, archivedAt: null },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true },
  });
  return fallback?.id ?? null;
}
