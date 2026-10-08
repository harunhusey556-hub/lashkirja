/**
 * Fills a throwaway demo database with data that makes the app worth looking
 * at: a bank account with a reconciled month, customers, invoices in every
 * state, a payable and a recurring schedule.
 *
 * Never point this at a real database - it assumes it owns the data.
 */
import "dotenv/config";
import * as bcrypt from "bcryptjs";
import { prisma } from "../src/lib/db";
import { createBankAccount, upsertMonthlyBalance } from "../src/lib/bank-accounts";
import { createCustomer } from "../src/lib/customers";
import { createInvoice, recordPayment, setInvoiceStatus } from "../src/lib/sales-invoices";
import { createPurchaseInvoice } from "../src/lib/purchase-invoices";
import { createRecurringInvoice } from "../src/lib/recurring-invoices";

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/**
 * `--ci` (the iOS Simulator check only, .github/workflows/ios-sim-check.yml):
 * also seed a second, NOT onboarded user, so the autopilot can walk the chat
 * onboarding end to end. Without the flag the demo seed is unchanged.
 */
const CI_FLAG = process.argv.slice(2).includes("--ci");
const CI_ONBOARDING_EMAIL = "onboarding@lashkirja.fi";

async function ensureCiOnboardingUser() {
  const existing = await prisma.user.findUnique({ where: { email: CI_ONBOARDING_EMAIL } });
  if (existing) {
    console.log("CI onboarding user already present.");
    return;
  }
  await prisma.user.create({
    data: {
      email: CI_ONBOARDING_EMAIL,
      passwordHash: await bcrypt.hash("demo123", 10),
      firstName: "Oona",
      lastName: "Uusi",
      onboarded: false,
    },
  });
  console.log(`CI onboarding user ready: ${CI_ONBOARDING_EMAIL} / demo123 (onboarded: false)`);
}

async function main() {
  if (CI_FLAG) await ensureCiOnboardingUser();
  const email = "demo@lashkirja.fi";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log("Demo user already present; nothing to do.");
    return;
  }

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash("demo123", 10),
      firstName: "Liisa",
      lastName: "Demo",
      onboarded: true,
      vatRegistered: true,
      businessName: "Liisan Ripsistudio",
      businessId: "0201256-6",
      addressStreet: "Kauppakatu 1",
      addressPostalCode: "00100",
      addressCity: "Helsinki",
      phone: "040 1234567",
      invoiceIban: "FI2112345600000785",
      invoiceBic: "NDEAFIHH",
      invoiceTerms: "Viivästyskorko 11,5 %. Huomautusaika 8 päivää.",
      lateInterestPercent: 11.5,
    },
  });

  const account = await createBankAccount(user.id, {
    name: "Käyttötili",
    bankName: "Nordea",
    iban: "FI2112345600000785",
    openingBalance: 2500,
    openingDate: isoDaysAgo(120),
    isDefault: true,
  });

  const statement = await prisma.statement.create({
    data: {
      userId: user.id,
      bankAccountId: account.id,
      fileName: "tiliote-demo.csv",
      fileType: "csv",
      filePath: "/tmp/demo.csv",
      checksum: "demo-checksum",
      periodMonth: isoDaysAgo(30).slice(0, 7),
      transactions: {
        create: [
          {
            date: new Date(`${isoDaysAgo(28)}T00:00:00Z`),
            amountCents: 24_500,
            counterparty: "Anna Asiakas",
            type: "tulo",
          },
          {
            date: new Date(`${isoDaysAgo(21)}T00:00:00Z`),
            amountCents: -13_900,
            counterparty: "Ripsitukku Oy",
            type: "meno",
          },
          {
            date: new Date(`${isoDaysAgo(14)}T00:00:00Z`),
            amountCents: -4_500,
            counterparty: "Sähköyhtiö",
            type: "meno",
          },
        ],
      },
    },
    include: { transactions: true },
  });

  await upsertMonthlyBalance(user.id, account.id, {
    month: isoDaysAgo(30).slice(0, 7),
    closingBalance: 2500 + 245 - 139 - 45,
    note: "Pankin ilmoittama saldo",
  });

  const anna = await createCustomer(user.id, {
    name: "Anna Asiakas",
    email: "anna@example.fi",
    phone: "050 7654321",
    addressStreet: "Asiakastie 5",
    addressPostalCode: "00200",
    addressCity: "Espoo",
    defaultPaymentTermDays: 14,
  });

  const kauneus = await createCustomer(user.id, {
    name: "Kauneus Oy",
    businessId: "2454577-7",
    email: "laskut@kauneus.example",
    defaultPaymentTermDays: 30,
  });

  // Paid
  const paid = await createInvoice(user.id, {
    customerId: anna.id,
    issueDate: isoDaysAgo(35),
    lines: [
      { description: "Ripsienpidennys, uudet", quantity: 1, unitPrice: 120, vatRate: 25.5 },
      { description: "Ripsiseerumi", quantity: 1, unitPrice: 25, vatRate: 25.5 },
    ],
  });
  await setInvoiceStatus(user.id, paid.id, "sent");
  await recordPayment(user.id, paid.id, {
    amount: paid.gross,
    paidDate: isoDaysAgo(28),
    transactionId: statement.transactions[0].id,
    source: "bank",
    note: "Kohdistettu viitenumerolla",
  });

  // Overdue
  const overdue = await createInvoice(user.id, {
    customerId: kauneus.id,
    issueDate: isoDaysAgo(45),
    dueDate: isoDaysAgo(15),
    lines: [{ description: "Koulutuspäivä", quantity: 1, unitPrice: 480, vatRate: 25.5 }],
  });
  await setInvoiceStatus(user.id, overdue.id, "sent");

  // Sent, still on time
  const open = await createInvoice(user.id, {
    customerId: anna.id,
    issueDate: isoDaysAgo(5),
    lines: [{ description: "Huoltokäynti", quantity: 1, unitPrice: 65, vatRate: 25.5 }],
  });
  await setInvoiceStatus(user.id, open.id, "sent");

  // Draft
  await createInvoice(user.id, {
    customerId: kauneus.id,
    issueDate: isoDaysAgo(1),
    lines: [{ description: "Ripsituotepaketti", quantity: 3, unitPrice: 39, vatRate: 25.5 }],
  });

  await createPurchaseInvoice(user.id, {
    supplierName: "Ripsitukku Oy",
    supplierBusinessId: "0201256-6",
    issueDate: isoDaysAgo(25),
    dueDate: isoDaysAgo(3),
    gross: 139,
    vat: 28.24,
    category: "tarvikkeet",
  });

  await createRecurringInvoice(user.id, {
    customerId: kauneus.id,
    name: "Kuukausiylläpito",
    interval: "monthly",
    anchorDay: 1,
    startDate: isoDaysAgo(60),
    lines: [{ description: "Ylläpitosopimus", quantity: 1, unitPrice: 150, vatRate: 25.5 }],
  });

  await prisma.receipt.createMany({
    data: [
      {
        userId: user.id,
        vendor: "Ripsitukku Oy",
        date: new Date(`${isoDaysAgo(21)}T00:00:00Z`),
        totalAmountCents: 13_900,
        category: "tarvikkeet",
        type: "meno",
        vatDetails: JSON.stringify([{ rate: 25.5, amount: 28.24 }]),
        filePath: "/tmp/demo-1.pdf",
        fileName: "ripsitukku.pdf",
        reviewStatus: "approved",
      },
      {
        userId: user.id,
        vendor: "Sähköyhtiö",
        date: new Date(`${isoDaysAgo(14)}T00:00:00Z`),
        totalAmountCents: 4_500,
        category: "sähkö",
        type: "meno",
        vatDetails: JSON.stringify([{ rate: 25.5, amount: 9.14 }]),
        filePath: "/tmp/demo-2.pdf",
        fileName: "sahko.pdf",
        reviewStatus: "approved",
      },
    ],
  });

  if (CI_FLAG) await seedLongLists(user.id, account.id);

  console.log(`Demo data ready for ${email} / demo123`);
}

/**
 * Simulator only (`--ci`): lists longer than one "Näytä enemmän" step (10), so the walks open
 * long lists and fold them back the way an owner with a few months of receipts does.
 */
async function seedLongLists(userId: string, bankAccountId: string) {
  const vendors = ["K-Market", "Prisma", "Lidl", "Tokmanni", "Neste", "Clas Ohlson", "Verkkokauppa.com", "Posti"];
  await prisma.receipt.createMany({
    data: Array.from({ length: 26 }, (_, index) => ({
      userId,
      vendor: `${vendors[index % vendors.length]} ${index + 1}`,
      date: new Date(`${isoDaysAgo(2 + index * 2)}T00:00:00Z`),
      totalAmountCents: 1_000 + index * 137,
      category: "tarvikkeet",
      type: "meno",
      vatDetails: JSON.stringify([{ rate: 25.5, amount: Math.round((1_000 + index * 137) * 0.2032) / 100 }]),
      filePath: `/tmp/demo-long-${index}.pdf`,
      fileName: `kuitti-${index + 1}.pdf`,
      reviewStatus: "approved",
    })),
  });
  await prisma.statement.create({
    data: {
      userId,
      bankAccountId,
      fileName: "tiliote-pitka.csv",
      fileType: "csv",
      filePath: "/tmp/demo-long.csv",
      checksum: "demo-long-checksum",
      periodMonth: isoDaysAgo(0).slice(0, 7),
      transactions: {
        create: Array.from({ length: 26 }, (_, index) => ({
          date: new Date(`${isoDaysAgo(index % 7)}T00:00:00Z`),
          amountCents: -(500 + index * 111),
          counterparty: `${vendors[index % vendors.length]} ${index + 1}`,
          type: "meno",
        })),
      },
    },
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
