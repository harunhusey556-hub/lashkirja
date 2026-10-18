/**
 * Fills a throwaway demo database with data that makes the app worth looking
 * at: a bank account with a reconciled month, customers, invoices in every
 * state, a payable and a recurring schedule.
 *
 * Never point this at a real database - it assumes it owns the data.
 */
import "dotenv/config";
import * as bcrypt from "bcryptjs";
import type { Prisma } from "../src/generated/prisma/client";
import { prisma } from "../src/lib/db";
import { createBankAccount, upsertMonthlyBalance } from "../src/lib/bank-accounts";
import { addMonths } from "../src/lib/bank-balances";
import { createCustomer } from "../src/lib/customers";
import { confirmMatch, encodeMatchReasons, scorePair } from "../src/lib/matching";
import { centsToEuros } from "../src/lib/money";
import { setLockedThrough } from "../src/lib/period-lock";
import { createInvoice, recordPayment, setInvoiceStatus } from "../src/lib/sales-invoices";
import { createPurchaseInvoice, syncReceiptDocumentKind } from "../src/lib/purchase-invoices";
import { createRecurringInvoice } from "../src/lib/recurring-invoices";
import { helsinkiMonthKey } from "../src/lib/validation";
import { updateVatFiling } from "../src/lib/vat-filing";

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
  if (CI_FLAG) await seedWalkTasks(user.id, account.id);
  // Last: closing the month refuses anything dated inside it afterwards.
  if (CI_FLAG) await seedFinishedMonth(user.id, account.id);

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
  // A receipt whose bank row has the exact amount but another name (2026-10-08, "ABC Prisma
  // Kotka" / "KSO ABC Sahkonlataus"): no automatic suggestion, yet the receipt lists the row.
  await prisma.receipt.create({
    data: {
      userId,
      vendor: "ABC Prisma Kotka",
      date: new Date(`${isoDaysAgo(3)}T00:00:00Z`),
      totalAmountCents: 943,
      category: "tarvikkeet",
      type: "meno",
      vatDetails: JSON.stringify([{ rate: 25.5, amount: 1.91 }]),
      filePath: "/tmp/demo-abc.pdf",
      fileName: "abc.pdf",
      reviewStatus: "approved",
    },
  });
  await prisma.statement.create({
    data: {
      userId,
      bankAccountId,
      fileName: "tiliote-abc.csv",
      fileType: "csv",
      filePath: "/tmp/demo-abc.csv",
      checksum: "demo-abc-checksum",
      periodMonth: isoDaysAgo(2).slice(0, 7),
      transactions: {
        create: [{ date: new Date(`${isoDaysAgo(2)}T00:00:00Z`), amountCents: -943, counterparty: "KSO ABC Sahkonlataus", type: "meno" }],
      },
    },
  });
}

const daysAgo = (n: number) => new Date(`${isoDaysAgo(n)}T00:00:00Z`);
const vat = (eur: number) => JSON.stringify([{ rate: 25.5, amount: eur }]);

/**
 * Simulator only (`--ci`): one seed for the fix round's walks, so counts move once. A receipt
 * waiting for Hyväksy, two credit notes, two sure pairs, a bill filed as an ostolasku and a
 * failed import. The credit notes and sure pairs are the audit walk's (audit-seed.ts on
 * audit/phase2-walk) under the same file names, checksum and counterparties, so that script
 * finds them and adds only its own rows.
 */
async function seedWalkTasks(userId: string, bankAccountId: string) {
  const receipt = (fileName: string, data: Omit<Prisma.ReceiptUncheckedCreateInput, "userId" | "fileName" | "filePath">) =>
    prisma.receipt.create({
      data: {
        userId,
        fileName,
        // A name the CI picture step replaces with a stored JPEG, as it does for the rows above.
        filePath: `/tmp/${fileName}`,
        type: "meno",
        category: "tarvikkeet",
        reviewStatus: "approved",
        ...data,
      },
    });

  // P1 test04 ends on its Hyväksy: every receipt above is approved already.
  await receipt("lumo-kosmetiikka.pdf", { vendor: "Lumo Kosmetiikka Oy", date: daysAgo(1), totalAmountCents: 2_380, vatDetails: vat(4.84), reviewStatus: "pending" });

  // A credit note is a receipt with a negative total and negative VAT (api/receipts/save). The
  // pending one also carries the long vendor name the Koti task row must show whole.
  await receipt("audit-hyvitys.pdf", { vendor: "Audit Hyvitys Oy", date: daysAgo(6), totalAmountCents: -5_000, vatDetails: vat(-10.16), invoiceNumber: "HYV-2026-1", notes: "Hyvityslasku" });
  await receipt("audit-hyvitys-odottaa.pdf", { vendor: "Audit Hyvitys Odottaa Oy", date: daysAgo(2), totalAmountCents: -1_890, vatDetails: vat(-3.84), notes: "Hyvityslasku", reviewStatus: "pending" });

  // Two sure pairs (the plural toasts "2 kuittia kohdistettu." / "2 kohdistusta kumottu."), each
  // with a rival receipt of the same name and amount that keeps it suggested.
  const tukku = await receipt("audit-tukku.pdf", { vendor: "Audit Tukku Oy", date: daysAgo(5), totalAmountCents: 8_765, reference: "1234567", vatDetails: vat(17.81) });
  await receipt("audit-tukku-kopio.pdf", { vendor: "Audit Tukku", date: daysAgo(5), totalAmountCents: 8_765, vatDetails: vat(17.81) });
  const kahvila = await receipt("audit-kahvila.pdf", { vendor: "Audit Kahvila Oy", date: daysAgo(3), totalAmountCents: 3_450, reference: "7654321", vatDetails: vat(7.01) });
  await receipt("audit-kahvila-kopio.pdf", { vendor: "Audit Kahvila", date: daysAgo(3), totalAmountCents: 3_450, vatDetails: vat(7.01) });
  const statement = await prisma.statement.create({
    data: {
      userId,
      bankAccountId,
      fileName: "tiliote-audit.csv",
      fileType: "csv",
      filePath: "/tmp/demo-audit.csv",
      checksum: "demo-audit-checksum",
      periodMonth: isoDaysAgo(4).slice(0, 7),
    },
  });
  await seedSurePair(statement.id, tukku, { date: daysAgo(4), counterparty: "Audit Tukku Oy", reference: "1234567", message: "Lasku 1234567" });
  await seedSurePair(statement.id, kahvila, { date: daysAgo(2), counterparty: "Audit Kahvila Oy", reference: "7654321", message: "Viite 7654321" });

  // Approved and filed as an ostolasku the way "Merkitse ostolaskuksi" files it: Raportit's
  // Menot counts it, while Kuitit's own list (kind=receipt) leaves it out.
  const bill = await receipt("vuokra-kauppakatu.pdf", { vendor: "Kiinteistö Oy Kauppakatu 1", date: daysAgo(3), totalAmountCents: 31_000, invoiceNumber: "VL-1048", category: "vuokra", vatDetails: vat(62.99) });
  const filed = await syncReceiptDocumentKind(userId, bill.id, "invoice");
  if (filed.action !== "filed") throw new Error(`demo seed: the rent bill was not filed as an ostolasku (${JSON.stringify(filed)})`);

  // Koti's "Tuonnit ja virheet" shows only while an import has failed; stored as withTrackedJob
  // leaves a mailbox check that threw.
  const failedAt = Date.now() - 60_000;
  await prisma.backgroundJob.create({
    data: {
      userId,
      kind: "email_scan",
      status: "failed",
      title: "Sähköpostin tarkistus",
      error: "Kirjautuminen sähköpostipalvelimelle epäonnistui.",
      progressLabel: "Epäonnistui",
      createdAt: new Date(failedAt),
      startedAt: new Date(failedAt),
      finishedAt: new Date(failedAt + 5_000),
    },
  });
}

/**
 * A bank row the server lists as a sure pair: viite + exact amount (the gate's `certain`) against
 * `receipt`, stored as the matcher stores a suggestion. The rival receipt makes the pair
 * "competing", so a matching run that a receipt save starts keeps it suggested instead of linking
 * it by itself (autoLinkSureMatches is off for the demo user).
 */
async function seedSurePair(
  statementId: string,
  receipt: { id: string; vendor: string | null; date: Date | null; totalAmountCents: number | null; type: string; reference: string | null; invoiceNumber: string | null },
  row: { date: Date; counterparty: string; reference: string; message: string }
) {
  const amountCents = -(receipt.totalAmountCents ?? 0);
  const pair = scorePair(
    { id: "seed", date: row.date, counterparty: row.counterparty, amount: centsToEuros(amountCents), reference: row.reference, message: row.message, type: "meno" },
    { ...receipt, totalAmount: receipt.totalAmountCents == null ? null : centsToEuros(receipt.totalAmountCents) }
  );
  if (!pair?.certain) {
    // Said in the job log rather than failing every class: only the sure-pair walks miss it.
    console.warn(`::warning::demo seed: ${row.counterparty} / ${receipt.vendor} is not a certain pair under today's gate (${JSON.stringify(pair)})`);
  }
  await prisma.transaction.create({
    data: {
      statementId,
      counterparty: row.counterparty,
      type: "meno",
      date: row.date,
      amountCents,
      reference: row.reference,
      message: row.message,
      matchStatus: "suggested",
      suggestedReceiptId: receipt.id,
      matchScore: pair?.score ?? null,
      matchReasons: pair ? encodeMatchReasons([...pair.reasons, "competing"], pair.explanation) : null,
    },
  });
}

/**
 * Simulator only (`--ci`): a finished month three months back, Kuukauden sulku's "… on valmis."
 * with its package. The month's card sales paid into the account and a supplies receipt paid from
 * it, each bank row linked to its receipt, the VAT return filed and paid, and the books closed
 * through the month. Receipts rather than a paid invoice: the work queue still lists a bank row
 * settled by an invoice payment as missing its receipt. The two rows cancel out, so the account's
 * later months reconcile exactly as the rows above leave them. Days from the 10th on stay after the
 * account's opening day (120 days back) in every month.
 */
async function seedFinishedMonth(userId: string, bankAccountId: string) {
  const month = addMonths(helsinkiMonthKey(new Date()), -3);
  const on = (dayOfMonth: number) => new Date(`${month}-${String(dayOfMonth).padStart(2, "0")}T00:00:00Z`);
  const receipt = (fileName: string, data: Omit<Prisma.ReceiptUncheckedCreateInput, "userId" | "fileName" | "filePath">) =>
    prisma.receipt.create({ data: { userId, fileName, filePath: `/tmp/${fileName}`, reviewStatus: "approved", ...data } });

  const supplies = await receipt("helmi-kosmetiikka.pdf", { vendor: "Helmi Kosmetiikka Oy", date: on(12), totalAmountCents: 10_040, category: "tarvikkeet", type: "meno", vatDetails: vat(20.4) });
  const sales = await receipt("korttimaksut.pdf", { vendor: "Korttimaksut", date: on(20), totalAmountCents: 10_040, category: "myynti", type: "tulo", vatDetails: vat(20.4) });
  const statement = await prisma.statement.create({
    data: {
      userId,
      bankAccountId,
      fileName: "tiliote-valmis.csv",
      fileType: "csv",
      filePath: "/tmp/demo-valmis.csv",
      checksum: "demo-finished-month-checksum",
      periodMonth: month,
      transactions: {
        create: [
          { date: on(12), amountCents: -10_040, counterparty: "Helmi Kosmetiikka Oy", type: "meno" },
          { date: on(20), amountCents: 10_040, counterparty: "Korttimaksut", type: "tulo" },
        ],
      },
    },
    include: { transactions: true },
  });
  const paidOut = statement.transactions.find((row) => row.type === "meno");
  const paidIn = statement.transactions.find((row) => row.type === "tulo");
  if (!paidOut || !paidIn) throw new Error("demo seed: the finished month's bank rows were not stored");
  await confirmMatch(userId, paidOut.id, supplies.id);
  await confirmMatch(userId, paidIn.id, sales.id);
  await updateVatFiling(userId, month, { filed: true, paid: true });
  await setLockedThrough(userId, month);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
