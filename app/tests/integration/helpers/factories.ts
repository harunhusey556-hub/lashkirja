import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";

export interface TestUser {
  id: string;
  email: string;
}

/** Wipes every table in FK-safe order. Called between tests. */
export async function resetDatabase(): Promise<void> {
  await prisma.matchRejection.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.monthlyBalance.deleteMany();
  await prisma.statement.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.upload.deleteMany();
  await prisma.bankAccount.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.imapAccount.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.catalogItem.deleteMany();
  await prisma.invoiceSequence.deleteMany();
  await prisma.automationEvent.deleteMany();
  await prisma.vendorCategoryRule.deleteMany();
  await prisma.backgroundJob.deleteMany();
  await prisma.connectedAccount.deleteMany();
  await prisma.bankConnection.deleteMany();
  await prisma.user.deleteMany();
}

export async function createUser(
  overrides: Partial<{ email: string; firstName: string; lastName: string }> = {}
): Promise<TestUser> {
  const email = overrides.email ?? `user-${randomUUID()}@example.com`;
  const user = await prisma.user.create({
    data: {
      email,
      // Real hashing is exercised by the auth routes; these tests seal sessions
      // directly, so a placeholder hash keeps the fixtures fast.
      passwordHash: "$2a$10$notarealhashnotarealhashnotarealhashnotarealha",
      firstName: overrides.firstName ?? "Testi",
      lastName: overrides.lastName ?? "Käyttäjä",
      onboarded: true,
    },
  });
  return { id: user.id, email: user.email };
}

export async function createBankAccountRow(
  userId: string,
  overrides: Partial<{
    name: string;
    iban: string | null;
    bankName: string | null;
    currency: string;
    openingBalanceCents: number;
    openingDate: string;
    isDefault: boolean;
  }> = {}
) {
  return prisma.bankAccount.create({
    data: {
      userId,
      name: overrides.name ?? "Käyttötili",
      bankName: overrides.bankName ?? null,
      iban: overrides.iban === undefined ? null : overrides.iban,
      currency: overrides.currency ?? "EUR",
      openingBalanceCents: overrides.openingBalanceCents ?? 0,
      openingDate: new Date(`${overrides.openingDate ?? "2026-01-01"}T00:00:00.000Z`),
      isDefault: overrides.isDefault ?? false,
    },
  });
}

export async function createStatementWithTransactions(
  userId: string,
  options: {
    bankAccountId?: string | null;
    periodMonth?: string;
    transactions: Array<{ date: string | null; amountCents: number; counterparty?: string }>;
  }
) {
  const statement = await prisma.statement.create({
    data: {
      userId,
      bankAccountId: options.bankAccountId ?? null,
      fileName: `tiliote-${randomUUID()}.csv`,
      fileType: "csv",
      filePath: `/tmp/${randomUUID()}.csv`,
      checksum: randomUUID(),
      periodMonth: options.periodMonth ?? "2026-01",
      transactions: {
        create: options.transactions.map((tx) => ({
          date: tx.date ? new Date(`${tx.date}T00:00:00.000Z`) : null,
          amountCents: tx.amountCents,
          counterparty: tx.counterparty ?? "Testi Oy",
          type: tx.amountCents >= 0 ? "tulo" : "meno",
        })),
      },
    },
    include: { transactions: true },
  });
  return statement;
}

export async function createReceipt(
  userId: string,
  overrides: Partial<{
    type: string;
    date: string | null;
    totalAmountCents: number | null;
    category: string | null;
    vendor: string;
    vatDetails: string | null;
    reviewStatus: string;
  }> = {}
) {
  return prisma.receipt.create({
    data: {
      userId,
      type: overrides.type ?? "meno",
      date:
        overrides.date === null
          ? null
          : new Date(`${overrides.date ?? "2026-01-15"}T00:00:00.000Z`),
      totalAmountCents:
        overrides.totalAmountCents === undefined ? 12_550 : overrides.totalAmountCents,
      category: overrides.category === undefined ? "tarvikkeet" : overrides.category,
      vendor: overrides.vendor ?? "Tukku Oy",
      vatDetails:
        overrides.vatDetails === undefined
          ? JSON.stringify([{ rate: 25.5, amount: 25.5 }])
          : overrides.vatDetails,
      reviewStatus: overrides.reviewStatus ?? "approved",
      filePath: `/tmp/${randomUUID()}.pdf`,
      fileName: "kuitti.pdf",
    },
  });
}

export async function createUpload(
  userId: string,
  overrides: Partial<{ purpose: string; originalName: string }> = {}
) {
  const key = `${randomUUID()}.pdf`;
  return prisma.upload.create({
    data: {
      userId,
      purpose: overrides.purpose ?? "receipt",
      storageKey: key,
      originalName: overrides.originalName ?? "kuitti.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      sha256: randomUUID().replace(/-/g, ""),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
}
