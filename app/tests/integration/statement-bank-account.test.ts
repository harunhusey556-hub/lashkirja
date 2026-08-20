import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "@/lib/db";
import { POST as uploadStatement } from "@/app/api/statements/route";
import { PATCH as patchStatement } from "@/app/api/statements/[id]/route";
import { createBankAccountRow, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let otherUser: TestUser;

const IBAN_A = "FI2112345600000785";
const IBAN_B = "FI7054000420152230";

function csv(iban: string | null): string {
  const header = iban ? `Tili;${iban}\n` : "";
  return (
    header +
    "Kirjauspäivä;Summa;Saaja\n" +
    "05.01.2026;250,00;Asiakas Oy\n" +
    "18.01.2026;-40,50;Tarvikekauppa\n"
  );
}

/** The upload route reads multipart form data, so build a real one. */
function uploadRequest(body: string, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new File([body], "tiliote.csv", { type: "text/csv" }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return buildFormRequest("/api/statements", form, { cookie });
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  otherUser = await createUser();
});

afterAll(() => {
  // The route writes real files; do not leave them behind.
  fs.rmSync(path.join(process.cwd(), "data", "uploads"), { recursive: true, force: true });
});

describe("statement upload -> bank account", () => {
  it("files the upload under the account whose IBAN appears in the file", async () => {
    const target = await createBankAccountRow(user.id, { name: "Nordea", iban: IBAN_A });
    await createBankAccountRow(user.id, {
      name: "OP",
      iban: IBAN_B,
      isDefault: true, // default must lose to an explicit IBAN match
    });

    const response = await uploadStatement(uploadRequest(csv(IBAN_A)));
    expect(response.status).toBe(200);
    const { statement } = await readJson(response);
    expect(statement.bankAccountId).toBe(target.id);
  });

  it("falls back to the default account when the file names no IBAN", async () => {
    await createBankAccountRow(user.id, { name: "Toissijainen" });
    const fallback = await createBankAccountRow(user.id, { name: "Oletus", isDefault: true });

    const { statement } = await readJson(await uploadStatement(uploadRequest(csv(null))));
    expect(statement.bankAccountId).toBe(fallback.id);
  });

  it("does not match an IBAN that belongs to another user", async () => {
    await createBankAccountRow(otherUser.id, { name: "Toisen tili", iban: IBAN_A });

    const { statement } = await readJson(await uploadStatement(uploadRequest(csv(IBAN_A))));
    expect(statement.bankAccountId).toBeNull();
  });

  it("leaves the statement unassigned when the user has no accounts", async () => {
    const { statement } = await readJson(await uploadStatement(uploadRequest(csv(IBAN_A))));
    expect(statement.bankAccountId).toBeNull();
  });

  it("honours an explicit account chosen at upload time", async () => {
    await createBankAccountRow(user.id, { name: "Oletus", iban: IBAN_A, isDefault: true });
    const chosen = await createBankAccountRow(user.id, { name: "Käteiskassa" });

    const { statement } = await readJson(
      await uploadStatement(uploadRequest(csv(IBAN_A), { bankAccountId: chosen.id }))
    );
    expect(statement.bankAccountId).toBe(chosen.id);
  });

  it("rejects an upload aimed at somebody else's account", async () => {
    const foreign = await createBankAccountRow(otherUser.id, { name: "Toisen tili" });
    const response = await uploadStatement(
      uploadRequest(csv(null), { bankAccountId: foreign.id })
    );
    expect(response.status).toBe(404);
    expect(await prisma.statement.count()).toBe(0);
  });

  it("skips archived accounts when choosing a fallback", async () => {
    const archived = await createBankAccountRow(user.id, { name: "Vanha", isDefault: true });
    await prisma.bankAccount.update({
      where: { id: archived.id },
      data: { archivedAt: new Date() },
    });
    const active = await createBankAccountRow(user.id, { name: "Nykyinen" });

    const { statement } = await readJson(await uploadStatement(uploadRequest(csv(null))));
    expect(statement.bankAccountId).toBe(active.id);
  });

  it("makes the transactions count towards that account's balance", async () => {
    const account = await createBankAccountRow(user.id, {
      name: "Nordea",
      iban: IBAN_A,
      openingBalanceCents: 100_00,
      openingDate: "2026-01-01",
    });
    await uploadStatement(uploadRequest(csv(IBAN_A)));

    const { getAccountRollforward } = await import("@/lib/bank-accounts");
    const rollforward = await getAccountRollforward(user.id, account.id, {
      throughMonth: "2026-01",
    });
    expect(rollforward.months[0]).toMatchObject({
      income: 250,
      expense: 40.5,
      computedClosing: 309.5,
    });
  });
});

describe("PATCH /api/statements/[id] - reassignment", () => {
  async function uploadOne() {
    const { statement } = await readJson(await uploadStatement(uploadRequest(csv(null))));
    return statement.id as string;
  }

  it("moves a statement to another account", async () => {
    const statementId = await uploadOne();
    const account = await createBankAccountRow(user.id, { name: "Nordea" });

    const response = await patchStatement(
      buildRequest("PATCH", `/api/statements/${statementId}`, { bankAccountId: account.id }, { cookie }),
      routeContext({ id: statementId })
    );
    expect(response.status).toBe(200);
    const stored = await prisma.statement.findUnique({ where: { id: statementId } });
    expect(stored?.bankAccountId).toBe(account.id);
  });

  it("detaches a statement when null is sent", async () => {
    const account = await createBankAccountRow(user.id, { name: "Nordea", isDefault: true });
    const statementId = await uploadOne();
    expect(
      (await prisma.statement.findUnique({ where: { id: statementId } }))?.bankAccountId
    ).toBe(account.id);

    await patchStatement(
      buildRequest("PATCH", `/api/statements/${statementId}`, { bankAccountId: null }, { cookie }),
      routeContext({ id: statementId })
    );
    expect(
      (await prisma.statement.findUnique({ where: { id: statementId } }))?.bankAccountId
    ).toBeNull();
  });

  it("still accepts a period-only patch", async () => {
    const statementId = await uploadOne();
    const response = await patchStatement(
      buildRequest("PATCH", `/api/statements/${statementId}`, { periodMonth: "2026-02" }, { cookie }),
      routeContext({ id: statementId })
    );
    expect(response.status).toBe(200);
    const stored = await prisma.statement.findUnique({ where: { id: statementId } });
    expect(stored).toMatchObject({ periodMonth: "2026-02", periodSource: "manual" });
  });

  it("rejects an empty patch and a foreign account", async () => {
    const statementId = await uploadOne();
    const foreign = await createBankAccountRow(otherUser.id, { name: "Toisen" });

    const empty = await patchStatement(
      buildRequest("PATCH", `/api/statements/${statementId}`, {}, { cookie }),
      routeContext({ id: statementId })
    );
    expect(empty.status).toBe(400);

    const stolen = await patchStatement(
      buildRequest("PATCH", `/api/statements/${statementId}`, { bankAccountId: foreign.id }, { cookie }),
      routeContext({ id: statementId })
    );
    expect(stolen.status).toBe(404);
  });

  it("keeps the statement when its account is deleted", async () => {
    const account = await createBankAccountRow(user.id, { name: "Poistettava", isDefault: true });
    const statementId = await uploadOne();

    // Statements block a hard delete, so remove the row directly to prove the
    // FK is SET NULL rather than CASCADE.
    await prisma.bankAccount.delete({ where: { id: account.id } });
    const stored = await prisma.statement.findUnique({ where: { id: statementId } });
    expect(stored).not.toBeNull();
    expect(stored?.bankAccountId).toBeNull();
  });
});
