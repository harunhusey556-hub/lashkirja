import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { incomingPrefilter, matchInvoicePaymentsFromBank } from "@/lib/sales-invoices";
import { referenceForInvoice } from "@/lib/finnish-reference";
import { GET as dashboard } from "@/app/api/dashboard/route";
import { createBankAccountRow, createStatementWithTransactions, createUser, resetDatabase } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/**
 * W28, Koti speed. The bank roll-forward is cached on the DataVersion stamp (books-cache), and
 * the invoice-payment run loads only the incoming rows that can reach one of its stages
 * (incomingPrefilter). Its result must be exactly what loading every unpaid incoming row gives,
 * on a ledger mixing reference, message, amount-and-name, ambiguous, locked and noise rows.
 */

const NOW = new Date("2026-10-13T09:00:00.000Z");
const NAMES = ["Anna Asiakas", "Bertil Bygg Oy", "Ceta Ky", "Delta Design Tmi", "Eetu Esimerkki"];
const DAY = 86_400_000;

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

/** Builds the same ledger for the same seed; returns ids in creation order for labelling. */
async function buildLedger(userId: string, seed: number) {
  const rnd = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  await prisma.user.update({ where: { id: userId }, data: { booksLockedThrough: "2026-04" } });
  const customers = [];
  for (const name of NAMES) customers.push(await prisma.customer.create({ data: { userId, name } }));

  const invoices: Array<{ id: string; number: number; reference: string; grossCents: number; openCents: number; due: Date; customer: string }> = [];
  for (let i = 0; i < 40; i++) {
    const number = 1000 + i;
    const customer = pick(customers);
    const issue = new Date(Date.UTC(2026, 2 + Math.floor(rnd() * 7), 1 + Math.floor(rnd() * 27)));
    const due = new Date(issue.getTime() + 14 * DAY);
    // Every seventh invoice has the same gross, so two candidates can tie.
    const grossCents = i % 7 === 0 ? 12_400 : 5_000 + Math.floor(rnd() * 200) * 100;
    const status = i % 9 === 4 ? "paid" : "sent";
    const invoice = await prisma.salesInvoice.create({
      data: {
        userId, customerId: customer.id, number, reference: referenceForInvoice(number),
        issueDate: issue, dueDate: due, status, grossCents, netCents: grossCents, vatCents: 0,
      },
    });
    let openCents = grossCents;
    if (i % 5 === 1) {
      await prisma.invoicePayment.create({ data: { invoiceId: invoice.id, amountCents: 2_000, paidDate: issue, source: "manual" } });
      openCents -= 2_000;
    }
    if (i % 6 === 2) {
      await prisma.salesInvoice.create({
        data: {
          userId, customerId: customer.id, number: 5000 + i, reference: referenceForInvoice(5000 + i),
          issueDate: issue, dueDate: due, status: "sent", documentKind: "credit_note", creditsInvoiceId: invoice.id,
          grossCents: -1_000, netCents: -1_000, vatCents: 0,
        },
      });
      openCents -= 1_000;
    }
    invoices.push({ id: invoice.id, number, reference: invoice.reference, grossCents, openCents, due, customer: customer.name });
  }

  const statement = await prisma.statement.create({
    data: { userId, fileName: `s-${seed}.csv`, fileType: "csv", filePath: "/tmp/s.csv", checksum: `w28-${seed}`, periodMonth: "2026-06" },
  });
  const rowIds: string[] = [];
  const spaced = (ref: string) => ref.replace(/(\d{3})(?=\d)/g, "$1 ");
  for (let i = 0; i < 220; i++) {
    const inv = pick(invoices);
    const kind = rnd();
    const offset = Math.floor(rnd() * 140) - 20;
    let date: Date | null = new Date(inv.due.getTime() + offset * DAY);
    if (rnd() < 0.05) date = null;
    let amountCents = 100 + Math.floor(rnd() * 90_000);
    let reference: string | null = null;
    let message: string | null = rnd() < 0.5 ? "Maksu" : null;
    let counterparty = pick([...NAMES, "Tuntematon Maksaja", "Oma tili"]);
    if (kind < 0.12) reference = inv.reference;
    else if (kind < 0.18) reference = `0${spaced(inv.reference)}`;
    else if (kind < 0.24) message = spaced(inv.reference);
    else if (kind < 0.3) message = `Lasku ${inv.number} kiitos`;
    else if (kind < 0.36) message = `viite ${spaced(inv.reference)} / tilaus 77`;
    else if (kind < 0.62) {
      amountCents = rnd() < 0.5 ? inv.openCents : inv.grossCents;
      counterparty = rnd() < 0.8 ? inv.customer : "Tuntematon Maksaja";
      if (rnd() < 0.3) reference = inv.reference;
    } else if (kind < 0.7) {
      amountCents = 12_400;
      counterparty = pick(NAMES);
    } else if (kind < 0.78) message = `Palkka ${Math.floor(rnd() * 12)}/2026`;
    else if (kind < 0.85) amountCents = -amountCents;
    const row = await prisma.transaction.create({
      data: { statementId: statement.id, userId, date, amountCents, reference, message, counterparty, type: amountCents > 0 ? "tulo" : "meno" },
    });
    rowIds.push(row.id);
    // Some rows already settled an invoice and stay out of both loads.
    if (i % 23 === 5 && amountCents > 0) {
      await prisma.invoicePayment.create({
        data: { invoiceId: pick(invoices).id, transactionId: row.id, amountCents: 100, paidDate: date ?? NOW, source: "bank" },
      });
    }
  }
  return { invoices, rowIds };
}

/** Replaces ids with creation-order labels so two builds of one seed compare equal. */
function labelled(value: unknown, ledger: Awaited<ReturnType<typeof buildLedger>>): unknown {
  const labels = new Map<string, string>();
  ledger.invoices.forEach((invoice) => labels.set(invoice.id, `invoice#${invoice.number}`));
  ledger.rowIds.forEach((id, index) => labels.set(id, `row#${index}`));
  return JSON.parse(JSON.stringify(value), (_key, v) => (typeof v === "string" && labels.has(v) ? labels.get(v) : v));
}

async function openInvoicesOf(userId: string) {
  return prisma.salesInvoice.findMany({
    where: { userId, status: "sent", documentKind: "invoice" },
    include: {
      payments: { select: { amountCents: true } },
      creditNotes: { select: { grossCents: true, status: true } },
      customer: { select: { name: true } },
    },
  });
}

describe("invoice-payment run: SQL prefilter of incoming rows (W28)", () => {
  let userId: string;
  beforeEach(async () => {
    await resetDatabase();
    userId = (await createUser()).id;
  });

  for (const seed of [1, 7, 42, 99, 2026]) {
    it(`dry run is identical with and without the prefilter (seed ${seed})`, async () => {
      await buildLedger(userId, seed);
      const all = await matchInvoicePaymentsFromBank(userId, NOW, { dryRun: true, scanAllIncoming: true });
      const filtered = await matchInvoicePaymentsFromBank(userId, NOW, { dryRun: true });
      // Order included: the first row wins a reference, and suggestions keep row order.
      expect(JSON.stringify(filtered)).toBe(JSON.stringify(all));
      // The ledger exercises every outcome, and the prefilter really leaves rows out.
      expect(all.preview!.length).toBeGreaterThan(0);
      expect(all.skippedLocked.length).toBeGreaterThan(0);
      expect(all.suggestions.length).toBeGreaterThan(0);
      const base = { statement: { userId }, amountCents: { gt: 0 }, invoicePayment: null };
      const loadedAll = await prisma.transaction.count({ where: base });
      const loadedFiltered = await prisma.transaction.count({
        where: { ...base, ...incomingPrefilter(await openInvoicesOf(userId)) },
      });
      expect(loadedFiltered).toBeLessThan(loadedAll);
    });
  }

  it("the booking run books the same payments with and without the prefilter", async () => {
    const first = await buildLedger(userId, 42);
    const all = labelled(await matchInvoicePaymentsFromBank(userId, NOW, { scanAllIncoming: true }), first);
    await resetDatabase();
    userId = (await createUser()).id;
    const second = await buildLedger(userId, 42);
    const filtered = labelled(await matchInvoicePaymentsFromBank(userId, NOW), second);
    expect(JSON.stringify(filtered)).toBe(JSON.stringify(all));
    expect((all as { applied: unknown[] }).applied.length).toBeGreaterThan(0);
  });

  it("loads every row when a reference has no digit (a message hit has no SQL test then)", () => {
    const invoice = {
      id: "x", number: 12, reference: "ABCD", issueDate: NOW, dueDate: NOW, grossCents: 100,
      payments: [], creditNotes: [], customer: { name: "A" },
    };
    expect(incomingPrefilter([invoice])).toEqual({});
    expect(incomingPrefilter([{ ...invoice, reference: "RF18 ABCD" }])).toEqual({});
    expect(incomingPrefilter([{ ...invoice, reference: "1232" }])).toHaveProperty("OR");
  });
});

describe("Koti bank position cache (W28)", () => {
  it("shows every bank write on the next open, never the cached balance", async () => {
    await resetDatabase();
    const user = await createUser();
    const cookie = await sessionCookie(user);
    type Bank = { bank: { totalBalance: number; accountCount: number } | null };
    const open = async () => (await readJson<Bank>(await dashboard(buildRequest("GET", "/api/dashboard", undefined, { cookie })))).bank!;

    const account = await createBankAccountRow(user.id, { iban: "FI2112345600000785", openingBalanceCents: 100_000 });
    const today = new Date().toISOString().slice(0, 10);
    const statement = await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      periodMonth: today.slice(0, 7),
      transactions: [{ date: today, amountCents: 25_000 }],
    });
    expect(await open()).toMatchObject({ totalBalance: 1250, accountCount: 1 });
    expect(await open()).toMatchObject({ totalBalance: 1250 });

    await prisma.transaction.create({
      data: { statementId: statement.id, userId: user.id, date: new Date(`${today}T00:00:00.000Z`), amountCents: -5_000, type: "meno" },
    });
    expect((await open()).totalBalance).toBe(1200);

    await prisma.bankAccount.update({ where: { id: account.id }, data: { openingBalanceCents: 200_000 } });
    expect((await open()).totalBalance).toBe(2200);

    await prisma.transaction.deleteMany({ where: { statementId: statement.id, amountCents: -5_000 } });
    expect((await open()).totalBalance).toBe(2250);

    await createBankAccountRow(user.id, { iban: "FI5810171000000122", name: "Toinen", openingBalanceCents: 1_000 });
    expect(await open()).toMatchObject({ totalBalance: 2260, accountCount: 2 });
  });
});
