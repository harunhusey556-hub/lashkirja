import { beforeEach, describe, expect, it } from "vitest";
import { GET as alv } from "@/app/api/alv/route";
import { GET as monthStatus } from "@/app/api/dashboard/month/route";
import { GET as exportPackage } from "@/app/api/export/package/route";
import { readStoredZip } from "@/lib/zip-store";
import { PATCH as patchInvoice } from "@/app/api/purchase-invoices/[id]/route";
import { GET as receiptCandidates } from "@/app/api/purchase-invoices/[id]/receipts/route";
import { prisma } from "@/lib/db";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

/**
 * M1-2: one purchase counts once in the VAT return. The supplier's PDF arrives
 * by mail as a purchase invoice and again as an approved receipt; the owner
 * settles it by linking, never by rejecting or cancelling anything.
 */

let user: TestUser;
let cookie: string;
const PERIOD = "2026-08";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function alvOf(): Promise<Json> {
  const response = await alv(buildRequest("GET", `/api/alv?period=${PERIOD}`, undefined, { cookie }));
  expect(response.status).toBe(200);
  return readJson(response);
}

async function purchase(overrides: Record<string, unknown> = {}) {
  return prisma.purchaseInvoice.create({
    data: {
      userId: user.id,
      supplierName: "Ripsitukku Oy",
      issueDate: new Date(`${PERIOD}-10T00:00:00.000Z`),
      dueDate: new Date(`${PERIOD}-24T00:00:00.000Z`),
      status: "open",
      grossCents: 12_400,
      vatCents: 2_519,
      netCents: 9_881,
      ...overrides,
    },
  });
}

async function link(invoiceId: string, receiptId: string | null) {
  const response = await patchInvoice(
    buildRequest("PATCH", `/api/purchase-invoices/${invoiceId}`, { receiptId }, { cookie }),
    routeContext({ id: invoiceId })
  );
  expect(response.status).toBe(200);
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

describe("M1-2: an invoice and the receipt of the same purchase count once", () => {
  it("leaves the invoice VAT out when supplier, amount and date equal the receipt's", async () => {
    await createReceipt(user.id, { date: `${PERIOD}-12`, totalAmountCents: 12_400, vendor: "Ripsitukku" });
    const before = await alvOf();
    await purchase();
    const after = await alvOf();
    expect(after.field307.amount).toBe(before.field307.amount);
    expect(after.sources.purchaseInvoiceCount).toBe(0);
    expect(after.skippedPurchaseInvoiceCount).toBe(1);
    expect(after.suspectedPurchaseDuplicateCount).toBe(0);
  });

  it("leaves it out on an equal invoice number, whatever the supplier name and date", async () => {
    const receipt = await createReceipt(user.id, { date: `${PERIOD}-28`, totalAmountCents: 99_900, vendor: "Eri nimi" });
    await prisma.receipt.update({ where: { id: receipt.id }, data: { invoiceNumber: "A-4471" } });
    await purchase({ invoiceNumber: "A-4471" });
    const body = await alvOf();
    expect(body.skippedPurchaseInvoiceCount).toBe(1);
    expect(body.sources.purchaseInvoiceCount).toBe(0);
  });

  it("leaves it out on an equal reference", async () => {
    const receipt = await createReceipt(user.id, { date: `${PERIOD}-28`, totalAmountCents: 99_900, vendor: "Eri nimi" });
    await prisma.receipt.update({ where: { id: receipt.id }, data: { reference: "12345 67890" } });
    await purchase({ reference: "1234567890" });
    expect((await alvOf()).skippedPurchaseInvoiceCount).toBe(1);
  });

  it("only flags a receipt that has the same amount and a close date but another supplier", async () => {
    await createReceipt(user.id, { date: `${PERIOD}-12`, totalAmountCents: 12_400, vendor: "Toinen Oy" });
    await purchase();
    const body = await alvOf();
    expect(body.sources.purchaseInvoiceCount).toBe(1);
    expect(body.skippedPurchaseInvoiceCount).toBe(0);
    expect(body.suspectedPurchaseDuplicateCount).toBe(1);
  });

  it("one receipt takes the place of one invoice only", async () => {
    await createReceipt(user.id, { date: `${PERIOD}-12`, totalAmountCents: 12_400, vendor: "Ripsitukku Oy" });
    await purchase();
    await purchase({ invoiceNumber: "toinen" });
    const body = await alvOf();
    expect(body.skippedPurchaseInvoiceCount).toBe(1);
    expect(body.sources.purchaseInvoiceCount).toBe(1);
  });

  it("settles a flagged pair by linking, and brings the invoice VAT back when the link is removed", async () => {
    const receipt = await createReceipt(user.id, { date: `${PERIOD}-12`, totalAmountCents: 12_400, vendor: "Toinen Oy" });
    const invoice = await purchase();
    const flagged = await alvOf();
    expect(flagged.suspectedPurchaseDuplicateCount).toBe(1);

    const listed = await readJson(
      await receiptCandidates(
        buildRequest("GET", `/api/purchase-invoices/${invoice.id}/receipts`, undefined, { cookie }),
        routeContext({ id: invoice.id })
      )
    );
    expect(listed.linked).toBeNull();
    expect(listed.candidates.map((candidate: Json) => candidate.id)).toEqual([receipt.id]);

    await link(invoice.id, receipt.id);
    const linked = await alvOf();
    expect(linked.sources.purchaseInvoiceCount).toBe(0);
    expect(linked.skippedPurchaseInvoiceCount).toBe(1);
    expect(linked.suspectedPurchaseDuplicateCount).toBe(0);
    expect(linked.field307.amount).toBeCloseTo(flagged.field307.amount - 25.19, 2);

    const after = await readJson(
      await receiptCandidates(
        buildRequest("GET", `/api/purchase-invoices/${invoice.id}/receipts`, undefined, { cookie }),
        routeContext({ id: invoice.id })
      )
    );
    expect(after.linked).toMatchObject({ id: receipt.id });

    await link(invoice.id, null);
    const unlinked = await alvOf();
    expect(unlinked.field307.amount).toBeCloseTo(flagged.field307.amount, 2);
    expect(unlinked.suspectedPurchaseDuplicateCount).toBe(1);
  });

  it("counts the invoice VAT and flags it while the linked receipt has no VAT breakdown, then drops it once the receipt counts", async () => {
    const receipt = await createReceipt(user.id, {
      date: `${PERIOD}-12`,
      totalAmountCents: 12_400,
      vendor: "Ripsitukku Oy",
      vatDetails: null,
    });
    const invoice = await purchase({ receiptId: receipt.id });
    const gap = await alvOf();
    expect(gap.sources.purchaseInvoiceCount).toBe(1);
    expect(gap.skippedPurchaseInvoiceCount).toBe(0);
    expect(gap.purchaseReceiptUnusableCount).toBe(1);

    await prisma.receipt.update({ where: { id: receipt.id }, data: { vatDetails: JSON.stringify([{ rate: 25.5, amount: 25.19 }]) } });
    const complete = await alvOf();
    expect(complete.sources.purchaseInvoiceCount).toBe(0);
    expect(complete.skippedPurchaseInvoiceCount).toBe(1);
    expect(complete.purchaseReceiptUnusableCount).toBe(0);
    expect(complete.field307.amount).toBeCloseTo(25.19, 2);
    expect(invoice.id).toBeTruthy();
  });

  it("counts the invoice VAT when the linked receipt has no date", async () => {
    const receipt = await createReceipt(user.id, { date: null, totalAmountCents: 12_400 });
    await purchase({ receiptId: receipt.id });
    const body = await alvOf();
    expect(body.sources.purchaseInvoiceCount).toBe(1);
    expect(body.purchaseReceiptUnusableCount).toBe(1);
  });
});

describe("M1-3: a month that holds only a purchase invoice has content", () => {
  it("does not say the month is empty, so it can be checked and closed", async () => {
    const month = async () =>
      readJson(await monthStatus(buildRequest("GET", `/api/dashboard/month?month=${PERIOD}`, undefined, { cookie })));
    expect((await month()).hasContent).toBe(false);
    await purchase();
    const body = await month();
    expect(body.purchaseInvoiceCount).toBe(1);
    expect(body.hasContent).toBe(true);
    // Another month stays empty.
    const other = await readJson(
      await monthStatus(buildRequest("GET", "/api/dashboard/month?month=2026-05", undefined, { cookie }))
    );
    expect(other.hasContent).toBe(false);
  });
});

describe("M1-5: the accountant package lists the purchase invoices behind field 307", () => {
  it("has csv/ostolaskut.csv saying which invoice counted and which was left out, and agrees with alv.json", async () => {
    await createReceipt(user.id, { date: `${PERIOD}-12`, totalAmountCents: 12_400, vendor: "Ripsitukku Oy" });
    await purchase({ invoiceNumber: "A-1" }); // same purchase as the receipt: left out
    await purchase({ supplierName: "=HYPERLINK(1)", grossCents: 5_000, vatCents: 1_000, netCents: 4_000, invoiceNumber: "B-2" });
    await purchase({ supplierName: "Mitätöity Oy", status: "cancelled", grossCents: 7_000, vatCents: 1_400, netCents: 5_600 });

    const response = await exportPackage(buildRequest("GET", `/api/export/package?month=${PERIOD}`, undefined, { cookie }));
    expect(response.status).toBe(200);
    const files = readStoredZip(Buffer.from(await response.arrayBuffer()));
    const csv = files.get("csv/ostolaskut.csv")!.toString("utf8");
    const lines = csv.replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(lines[0]).toBe("Päivä;Toimittaja;Laskun numero;Yhteensä;ALV;Tila;ALV:n käsittely;Huomio");
    expect(lines).toHaveLength(4);
    expect(csv).toContain("2026-08-10;Ripsitukku Oy;A-1;124,00;25,19;Odottaa maksua;Pois: sama osto on mukana kuittina;");
    // A text cell that starts like a formula is neutralised, like in the other CSVs.
    expect(csv).toContain("'=HYPERLINK(1);B-2;50,00;10,00;Odottaa maksua;Mukana vähennettävässä ALV:ssä");
    expect(csv).toContain("Mitätöity Oy;;70,00;14,00;Mitätöity;Pois: mitätöity");
    const alvJson = JSON.parse(files.get("raportit/alv.json")!.toString("utf8"));
    expect(alvJson.sources.purchaseInvoiceVat).toBe(10);
    expect(files.get("lue-minut.txt")!.toString("utf8")).toContain("ostolaskut.csv");
  });
});
