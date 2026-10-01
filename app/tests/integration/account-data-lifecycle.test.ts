import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { buildAccountCopyZip, completeAccountClose } from "@/lib/account-requests";
import { listSyncableImapAccounts, syncImapAccount } from "@/lib/mail-sync";
import { createReceipt, createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";

let user: TestUser;

/** Entry names and bytes of a stored zip. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    out.set(name, zip.subarray(start, start + size));
    offset = start + size;
  }
  return out;
}

async function seedAccount() {
  await prisma.user.update({
    where: { id: user.id },
    data: {
      phone: "+358401234567",
      addressStreet: "Testikatu 1",
      addressPostalCode: "00100",
      addressCity: "Helsinki",
      invoiceIban: "FI2112345600000785",
      invoiceBic: "NDEAFIHH",
      businessName: "Testi Oy",
      businessId: "1234567-8",
      businessDetails: JSON.stringify({ salesTypes: ["ripsipalvelut"] }),
    },
  });
  const customer = await prisma.customer.create({
    data: { userId: user.id, name: "Asiakas Oy", addressStreet: "Asiakaskatu 2", addressCity: "Espoo", email: "a@example.com" },
  });
  await prisma.salesInvoice.create({
    data: {
      userId: user.id,
      customerId: customer.id,
      number: 1,
      reference: "1018",
      issueDate: new Date("2026-09-01T00:00:00Z"),
      dueDate: new Date("2026-09-15T00:00:00Z"),
      status: "sent",
      netCents: 10_000,
      vatCents: 2_550,
      grossCents: 12_550,
      lines: { create: [{ description: "Ripsien pidennys", quantityMilli: 1000, unitPriceCents: 10_000, netCents: 10_000 }] },
    },
  });
  await createReceipt(user.id);
  await createStatementWithTransactions(user.id, { transactions: [{ date: "2026-09-02", amountCents: 12_550 }] });
  await prisma.imapAccount.create({
    data: { userId: user.id, email: "posti@example.com", host: "imap.example.com", encryptedPass: "SALAINEN-SALASANA" },
  });
  const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "Alv-kysymys" } });
  await prisma.chatMessage.createMany({
    data: [
      { userId: user.id, conversationId: conversation.id, role: "user", content: "Paljonko alvia?" },
      { userId: user.id, conversationId: conversation.id, role: "assistant", content: "Noin 25,50 euroa." },
    ],
  });
  await prisma.bankConnection.create({
    data: {
      userId: user.id,
      aspspName: "Testipankki",
      aspspCountry: "FI",
      psuType: "business",
      status: "active",
      sessionIdEnc: "SALAINEN-ISTUNTO",
      authStateHash: "hash",
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
});

describe("the data copy (F56)", () => {
  it("holds what the Tietosuoja page says is stored, and none of the secrets", async () => {
    await seedAccount();
    const files = readZip(await buildAccountCopyZip(user.id));
    const text = (name: string) => files.get(name)?.toString("utf8") ?? "";

    for (const name of [
      "lue-minut.txt",
      "profiili.json",
      "asiakkaat.json",
      "laskut.json",
      "kuitit.json",
      "tiliotteet.json",
      "tilitapahtumat.json",
      "pankkiyhteydet.json",
      "postilaatikko.json",
      "avustaja.json",
    ]) {
      expect(files.has(name), name).toBe(true);
    }
    const profile = JSON.parse(text("profiili.json"));
    expect(profile).toMatchObject({ phone: "+358401234567", addressStreet: "Testikatu 1", invoiceIban: "FI2112345600000785" });
    expect(text("profiili.json")).not.toMatch(/passwordHash/);
    expect(JSON.parse(text("asiakkaat.json"))[0]).toMatchObject({ addressStreet: "Asiakaskatu 2" });
    const invoices = JSON.parse(text("laskut.json"));
    expect(invoices[0].lines[0].description).toBe("Ripsien pidennys");
    expect(invoices[0].dueDate).toContain("2026-09-15");
    expect(JSON.parse(text("avustaja.json"))[0].messages).toHaveLength(2);
    expect(JSON.parse(text("tilitapahtumat.json"))).toHaveLength(1);

    // Secrets stay out, and the manifest says so.
    const everything = [...files.values()].map((bytes) => bytes.toString("latin1")).join("\n");
    expect(everything).not.toContain("SALAINEN-SALASANA");
    expect(everything).not.toContain("SALAINEN-ISTUNTO");
    expect(text("lue-minut.txt")).toMatch(/salasan/i);
    expect(text("lue-minut.txt")).toMatch(/laskut\.json: 1/);
  });
});

describe("closing an account (F57)", () => {
  it("removes the mailbox credential, the assistant history and the bank secrets, and keeps the books", async () => {
    await seedAccount();
    const request = await prisma.accountRequest.create({ data: { userId: user.id, kind: "close", status: "pending" } });
    await completeAccountClose(request.id);

    expect(await prisma.imapAccount.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.conversation.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.chatMessage.count({ where: { userId: user.id } })).toBe(0);
    const connection = await prisma.bankConnection.findFirstOrThrow({ where: { userId: user.id } });
    expect(connection.sessionIdEnc).toBeNull();
    expect(connection.authStateHash).toBeNull();
    expect(connection.status).toBe("revoked");

    // Accounting records stay, and so do the details printed on them.
    expect(await prisma.salesInvoice.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.receipt.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.transaction.count({ where: { statement: { userId: user.id } } })).toBe(1);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.accessDisabledAt).not.toBeNull();
    expect(row.invoiceIban).toBe("FI2112345600000785");
    expect(row.businessId).toBe("1234567-8");
    // Not part of a retained document.
    expect(row.phone).toBeNull();
    expect(row.businessDetails).toBeNull();
  });

  it("the mailbox worker no longer sees a closed owner's mailbox, and a sync refuses it", async () => {
    await seedAccount();
    const mailbox = await prisma.imapAccount.findFirstOrThrow({ where: { userId: user.id } });
    expect((await listSyncableImapAccounts()).map((row) => row.id)).toContain(mailbox.id);

    await prisma.user.update({ where: { id: user.id }, data: { accessDisabledAt: new Date() } });
    expect((await listSyncableImapAccounts()).map((row) => row.id)).not.toContain(mailbox.id);
    await expect(syncImapAccount(mailbox.id)).rejects.toThrow(/suljettu/);
  });
});
