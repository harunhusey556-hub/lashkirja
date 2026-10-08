import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { findSameInvoiceReceipt, invoiceNumberKey } from "@/lib/mail-sync";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";

/** An invoice and its payment receipt from one email are one purchase (Anthropic, 2026-10). */

let user: TestUser;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
});

async function receiptWithInvoice(invoiceNumber: string, totalAmountCents: number, reviewStatus = "approved") {
  const receipt = await createReceipt(user.id, { totalAmountCents, vendor: "Anthropic, PBC", reviewStatus });
  return prisma.receipt.update({ where: { id: receipt.id }, data: { invoiceNumber } });
}

describe("findSameInvoiceReceipt", () => {
  it("finds the invoice's receipt whatever the punctuation of the number", async () => {
    const first = await receiptWithInvoice("8JOO0FMM0001", 22_590);
    expect(invoiceNumberKey("8joo0fmm-0001")).toBe("8JOO0FMM0001");
    expect((await findSameInvoiceReceipt(user.id, { invoiceNumber: "8JOO0FMM-0001", totalAmount: 225.9 }))?.id).toBe(first.id);
  });

  it("does not match another total, a rejected receipt, another owner or a too short number", async () => {
    await receiptWithInvoice("8JOO0FMM0002", 22_590);
    await receiptWithInvoice("8JOO0FMM0003", 22_590, "rejected");
    expect(await findSameInvoiceReceipt(user.id, { invoiceNumber: "8JOO0FMM0002", totalAmount: 99 })).toBeNull();
    expect(await findSameInvoiceReceipt(user.id, { invoiceNumber: "8JOO0FMM0003", totalAmount: 225.9 })).toBeNull();
    const other = await createUser();
    expect(await findSameInvoiceReceipt(other.id, { invoiceNumber: "8JOO0FMM0002", totalAmount: 225.9 })).toBeNull();
    await receiptWithInvoice("12", 100);
    expect(await findSameInvoiceReceipt(user.id, { invoiceNumber: "12", totalAmount: 1 })).toBeNull();
  });
});
