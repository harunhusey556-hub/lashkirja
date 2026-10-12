/**
 * W27 (owner report 2026-10-12, reproduced on his backup): bills uploaded from the phone were filed
 * as ostolaskut without their viite, so the payment the bank showed with that very viite never paid
 * them, and nothing ran the purchase matching after a sync or import. In Kuitit the same bills were
 * left out of "Ei kohdistettu" (kuitit-only `kind`), so the chip said 0 while they all waited for a
 * payment. A look-alike that the owner did not want to keep could not be dropped.
 *
 * The bill below is an anonymised shape of one of the 24 real ones: a Finnish supplier invoice with
 * a viite and an invoice number, 195,02 € with 25,5 % VAT, paid days after its date by a bank row
 * that carries the same viite and the supplier's name in capitals.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { POST as saveReceipt } from "@/app/api/receipts/save/route";
import { GET as listReceipts } from "@/app/api/receipts/route";
import { GET as receiptCounts } from "@/app/api/receipts/counts/route";
import { DELETE as deleteReceipt } from "@/app/api/receipts/[id]/route";
import { DELETE as discardStaged } from "@/app/api/receipts/staged/[uploadId]/route";
import { POST as uploadStatement } from "@/app/api/statements/route";
import { POST as recordPayment } from "@/app/api/purchase-invoices/[id]/payments/route";
import { createPurchaseInvoice, matchPurchasePaymentsFromBank } from "@/lib/purchase-invoices";
import { encrypt } from "@/lib/encryption";
import type { EnableBankingClient } from "@/lib/enablebanking/client";
import type { EbTransaction } from "@/lib/enablebanking/mapping";
import { syncBankConnection } from "@/lib/enablebanking/sync";
import { createReceipt, createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

const VIITE = "20260627012";
let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

afterAll(() => {
  fs.rmSync(path.join(process.cwd(), "data", "uploads"), { recursive: true, force: true });
});

interface Bill {
  vendor?: string;
  date?: string;
  total?: number;
  reference?: string | null;
  invoiceNumber?: string;
}

/** A read bill as the phone's queue leaves it: staged with the AI reading, then saved with autoApprove. */
async function stageBill(bill: Bill = {}) {
  const reading = {
    vendor: bill.vendor ?? "Toimittaja Oy",
    date: bill.date ?? "2026-06-27",
    totalAmount: bill.total ?? 195.02,
    vatDetails: [{ rate: 25.5, amount: 39.02 }],
    category: "ohjelmistot",
    notes: null,
    type: "meno",
    reference: bill.reference === undefined ? VIITE : bill.reference,
    invoiceNumber: bill.invoiceNumber ?? "4711",
    documentType: "invoice",
    dueDate: "2026-07-11",
    currency: "EUR",
  };
  return prisma.upload.create({
    data: {
      userId: user.id,
      purpose: "receipt",
      storageKey: `${randomUUID()}.pdf`,
      originalName: "lasku.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      sha256: randomUUID().replace(/-/g, ""),
      extractedJson: JSON.stringify(reading),
      extractionSource: "ai",
      confidence: 0.95,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
}

async function saveBill(bill: Bill = {}, extra: Record<string, unknown> = {}) {
  const upload = await stageBill(bill);
  const reading = JSON.parse(upload.extractedJson!);
  const body = {
    uploadId: upload.id,
    vendor: reading.vendor,
    date: reading.date,
    totalAmount: reading.totalAmount,
    vatDetails: reading.vatDetails,
    category: reading.category,
    type: "meno",
    ...(reading.reference ? { reference: reading.reference } : {}),
    invoiceNumber: reading.invoiceNumber,
    currency: "EUR",
    autoApprove: true,
    ...extra,
  };
  const response = await saveReceipt(buildRequest("POST", "/api/receipts/save", body, { cookie }));
  return { response, upload, json: await readJson(response) };
}

const HEADER = "Kirjauspäivä;Summa;Saaja;Viite\n";
function importCsv(lines: string) {
  const form = new FormData();
  form.set("file", new File([HEADER + lines], `tiliote-${randomUUID()}.csv`, { type: "text/csv" }));
  return uploadStatement(buildFormRequest("/api/statements", form, { cookie }));
}

const billOf = async (receiptId: string) =>
  prisma.purchaseInvoice.findFirstOrThrow({ where: { receiptId }, include: { payments: true } });

describe("ostolaskut are paid by the bank row that carries their viite", () => {
  it("files a bill with the viite the reading found", async () => {
    const { response, json } = await saveBill();
    expect(response.status).toBe(200);
    expect((await billOf(json.receipt.id)).reference).toBe(VIITE);
  });

  it("a misread viite (wrong check digit) never stops the filing; the bill is filed without it", async () => {
    const { response, json } = await saveBill({ reference: "20260627013" });
    expect(response.status).toBe(200);
    const bill = await billOf(json.receipt.id);
    expect(bill.status).toBe("open");
    expect(bill.reference).toBeNull();
  });

  it("a payment imported after the bill pays it automatically", async () => {
    const { json } = await saveBill();
    const imported = await importCsv(`01.07.2026;-195,02;TOIMITTAJA OY;${VIITE}\n`);
    expect(imported.status).toBe(200);
    const bill = await billOf(json.receipt.id);
    expect(bill.status).toBe("paid");
    expect(bill.payments).toHaveLength(1);
    expect(bill.payments[0].transactionId).not.toBeNull();
  });

  it("a bill uploaded after its payment was imported is paid as it is saved", async () => {
    expect((await importCsv(`01.07.2026;-195,02;TOIMITTAJA OY;${VIITE}\n`)).status).toBe(200);
    const { json } = await saveBill();
    const bill = await billOf(json.receipt.id);
    expect(bill.status).toBe("paid");
    expect(bill.payments[0].amountCents).toBe(19_502);
  });

  it("a payment the bank sync brings in pays the bill", async () => {
    const { json } = await saveBill();
    const connection = await prisma.bankConnection.create({
      data: {
        userId: user.id,
        aspspName: "Testipankki",
        aspspCountry: "FI",
        psuType: "business",
        status: "active",
        sessionIdEnc: encrypt("session-1"),
        validUntil: new Date("2099-01-01T00:00:00.000Z"),
        accounts: {
          create: [{ userId: user.id, iban: "FI2112345600000785", label: "Käyttötili", providerAccountUid: "acc-1", inScope: true }],
        },
      },
    });
    const row: EbTransaction = {
      status: "BOOK",
      booking_date: "2026-07-01",
      credit_debit_indicator: "DBIT",
      transaction_amount: { currency: "EUR", amount: "195.02" },
      creditor: { name: "TOIMITTAJA OY" },
      reference_number: VIITE,
      entry_reference: "E1",
    };
    const client = {
      getSession: async () => ({ status: "AUTHORIZED" }),
      getAccountBalances: async () => [],
      getAccountTransactions: async () => ({ transactions: [row], continuationKey: null }),
    } as unknown as EnableBankingClient;
    const result = await syncBankConnection(user.id, connection.id, { attended: false, client });
    expect(result.imported).toBe(1);
    expect((await billOf(json.receipt.id)).status).toBe("paid");
  });

  it("a fixed viite: an older payment of another bill is never booked on the new one", async () => {
    // The owner's freight and pension bills share one viite per supplier; the bank holds months of
    // earlier payments with it. Seen on his data: the first old row was booked as a part payment.
    const { json } = await saveBill({ date: "2026-07-15", total: 202.95 });
    const imported = await importCsv(
      `20.06.2026;-198,10;TOIMITTAJA OY;${VIITE}\n` + `25.07.2026;-202,95;TOIMITTAJA OY;${VIITE}\n` + `20.08.2026;-150,00;TOIMITTAJA OY;${VIITE}\n`
    );
    expect(imported.status).toBe(200);
    const bill = await billOf(json.receipt.id);
    expect(bill.status).toBe("paid");
    expect(bill.payments.map((payment) => payment.amountCents)).toEqual([20_295]);
  });

  it("an ostolasku filed earlier without the viite is matched by its receipt's viite", async () => {
    const receipt = await prisma.receipt.update({
      where: { id: (await createReceipt(user.id, { vendor: "Toimittaja Oy", date: "2026-06-27", totalAmountCents: 19_502 })).id },
      data: { reference: VIITE },
    });
    const legacy = await createPurchaseInvoice(user.id, {
      supplierName: "Toimittaja Oy",
      issueDate: "2026-06-27",
      dueDate: "2026-07-11",
      gross: 195.02,
      receiptId: receipt.id,
    });
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-07",
      transactions: [{ date: "2026-07-01", amountCents: -19_502, counterparty: "TOIMITTAJA OY" }],
    });
    await prisma.transaction.update({ where: { id: statement.transactions[0].id }, data: { reference: VIITE } });
    const result = await matchPurchasePaymentsFromBank(user.id);
    expect(result.applied.map((entry) => entry.invoiceId)).toEqual([legacy.id]);
  });
});

describe("Kuitit 'Ei kohdistettu': every document no bank row explains, kuitti or lasku", () => {
  it("counts and lists the same documents, with and without kind=receipt", async () => {
    const linkedKuitti = await createReceipt(user.id, { vendor: "Kahvila", date: "2026-07-02", totalAmountCents: 450 });
    const openKuitti = await createReceipt(user.id, { vendor: "Kioski", date: "2026-07-03", totalAmountCents: 820 });
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-07",
      transactions: [
        { date: "2026-07-02", amountCents: -450, counterparty: "Kahvila" },
        { date: "2026-07-20", amountCents: -26_082, counterparty: "Laskuttaja Ab" },
      ],
    });
    await prisma.transaction.update({ where: { id: statement.transactions[0].id }, data: { receiptId: linkedKuitti.id, matchStatus: "confirmed" } });
    // A bill nothing paid yet, and a bill paid from a bank row through its ostolasku.
    const openBill = (await saveBill({ reference: null })).json.receipt.id as string;
    const paidBill = (await saveBill({ vendor: "Laskuttaja Ab", date: "2026-07-15", total: 260.82, reference: null, invoiceNumber: "77" })).json.receipt.id as string;
    const paidInvoice = await billOf(paidBill);
    const paid = await recordPayment(
      buildRequest("POST", `/api/purchase-invoices/${paidInvoice.id}/payments`, { amount: 260.82, paidDate: "2026-07-20", transactionId: statement.transactions[1].id }, { cookie }),
      routeContext({ id: paidInvoice.id })
    );
    expect(paid.status).toBeLessThan(300);

    for (const kind of ["?kind=receipt", ""]) {
      const counts = (await readJson(await receiptCounts(buildRequest("GET", `/api/receipts/counts${kind}`, undefined, { cookie })))).counts;
      expect(counts.unlinked).toBe(2);
      expect(counts.linked).toBe(2);
      const list = await readJson(await listReceipts(buildRequest("GET", `/api/receipts${kind ? `${kind}&` : "?"}linkedStatus=unlinked`, undefined, { cookie })));
      expect(list.receipts.map((r: { id: string }) => r.id).sort()).toEqual([openKuitti.id, openBill].sort());
      expect(list.count).toBe(2);
    }
    // The kuitit tabs keep their own kind: the two bills are counted under Laskut.
    const counts = (await readJson(await receiptCounts(buildRequest("GET", "/api/receipts/counts?kind=receipt", undefined, { cookie })))).counts;
    expect(counts.all).toBe(2);
    expect(counts.laskut).toBe(2);

    const linked = await readJson(await listReceipts(buildRequest("GET", "/api/receipts?kind=receipt&linkedStatus=linked", undefined, { cookie })));
    const byId = new Map(linked.receipts.map((r: { id: string; match: { status: string } }) => [r.id, r.match.status]));
    expect([...byId.keys()].sort()).toEqual([linkedKuitti.id, paidBill].sort());
    // The paid bill's row says "Kohdistettu" like the kuitti's.
    expect(byId.get(paidBill)).toBe("linked");
  });
});

describe("a look-alike the owner does not want: 'Älä tallenna' drops it", () => {
  it("DELETE /api/receipts/staged/{uploadId} removes the staged upload and its file, only the owner's and only unsaved", async () => {
    const first = await saveBill();
    expect(first.response.status).toBe(200);
    const twin = await stageBill();
    const refused = await saveReceipt(
      buildRequest("POST", "/api/receipts/save", { uploadId: twin.id, vendor: "Toimittaja Oy", date: "2026-06-27", totalAmount: 195.02, type: "meno" }, { cookie })
    );
    expect(refused.status).toBe(409);

    const other = await createUser();
    const foreign = await discardStaged(
      buildRequest("DELETE", `/api/receipts/staged/${twin.id}`, undefined, { cookie: await sessionCookie(other) }),
      routeContext({ uploadId: twin.id })
    );
    expect(foreign.status).toBe(404);

    const dropped = await discardStaged(buildRequest("DELETE", `/api/receipts/staged/${twin.id}`, undefined, { cookie }), routeContext({ uploadId: twin.id }));
    expect(dropped.status).toBe(200);
    expect(await prisma.upload.findUnique({ where: { id: twin.id } })).toBeNull();
    expect(await prisma.receipt.count({ where: { userId: user.id } })).toBe(1);

    // A saved receipt's upload is not "staged": this route never deletes a receipt's file.
    const saved = await discardStaged(
      buildRequest("DELETE", `/api/receipts/staged/${first.upload.id}`, undefined, { cookie }),
      routeContext({ uploadId: first.upload.id })
    );
    expect(saved.status).toBe(404);
    expect(await prisma.upload.findUnique({ where: { id: first.upload.id } })).not.toBeNull();
  });

  it("a look-alike saved anyway (pending) is deleted from Kuitit like any receipt", async () => {
    await saveBill();
    const forced = await saveBill({}, { forceDuplicate: true });
    expect(forced.response.status).toBe(200);
    const id = forced.json.receipt.id as string;
    expect((await prisma.receipt.findUniqueOrThrow({ where: { id } })).reviewStatus).toBe("pending");
    const removed = await deleteReceipt(buildRequest("DELETE", `/api/receipts/${id}`, undefined, { cookie }), routeContext({ id }));
    expect(removed.status).toBe(200);
    expect(await prisma.receipt.count({ where: { userId: user.id } })).toBe(1);
  });
});
