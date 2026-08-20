import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as listAccounts, POST as createAccount } from "@/app/api/bank-accounts/route";
import {
  DELETE as deleteAccount,
  GET as getAccount,
  PATCH as patchAccount,
} from "@/app/api/bank-accounts/[id]/route";
import {
  DELETE as deleteBalance,
  PUT as putBalance,
} from "@/app/api/bank-accounts/[id]/balances/route";
import {
  createBankAccountRow,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import {
  buildRequest,
  readJson,
  routeContext,
  sessionCookie,
  type JsonValue,
} from "./helpers/http";

let user: TestUser;
let cookie: string;
let otherUser: TestUser;
let otherCookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  otherUser = await createUser();
  otherCookie = await sessionCookie(otherUser);
});

async function postAccount(body: unknown, auth = cookie) {
  return createAccount(buildRequest("POST", "/api/bank-accounts", body, { cookie: auth }));
}

describe("POST /api/bank-accounts", () => {
  it("creates an account and makes the first one default", async () => {
    const response = await postAccount({
      name: "Käyttötili",
      iban: "FI21 1234 5600 0007 85",
      openingBalance: 1250.5,
      openingDate: "2026-01-01",
    });

    expect(response.status).toBe(201);
    const { account } = await readJson(response);
    expect(account).toMatchObject({
      name: "Käyttötili",
      iban: "FI2112345600000785", // normalised on the way in
      openingBalance: 1250.5,
      openingDate: "2026-01-01",
      currency: "EUR",
      isDefault: true,
    });

    const stored = await prisma.bankAccount.findUnique({ where: { id: account.id } });
    expect(stored?.openingBalanceCents).toBe(125050);
  });

  it("does not make later accounts default automatically", async () => {
    await postAccount({ name: "Eka", openingBalance: 0, openingDate: "2026-01-01" });
    const second = await readJson(
      await postAccount({ name: "Toka", openingBalance: 0, openingDate: "2026-01-01" })
    );
    expect(second.account.isDefault).toBe(false);
  });

  it("moves the default flag when a new account claims it", async () => {
    const first = await readJson(
      await postAccount({ name: "Eka", openingBalance: 0, openingDate: "2026-01-01" })
    );
    await postAccount({
      name: "Toka",
      openingBalance: 0,
      openingDate: "2026-01-01",
      isDefault: true,
    });

    const reloaded = await prisma.bankAccount.findUnique({ where: { id: first.account.id } });
    expect(reloaded?.isDefault).toBe(false);
    expect(await prisma.bankAccount.count({ where: { userId: user.id, isDefault: true } })).toBe(1);
  });

  it("rejects an IBAN with a broken checksum", async () => {
    const response = await postAccount({
      name: "Väärä",
      iban: "FI2112345600000786",
      openingBalance: 0,
      openingDate: "2026-01-01",
    });
    expect(response.status).toBe(400);
    const body = await readJson(response);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(await prisma.bankAccount.count()).toBe(0);
  });

  it("rejects the same IBAN twice for one user", async () => {
    const payload = {
      name: "Tili",
      iban: "FI2112345600000785",
      openingBalance: 0,
      openingDate: "2026-01-01",
    };
    expect((await postAccount(payload)).status).toBe(201);
    const duplicate = await postAccount({ ...payload, name: "Kopio" });
    expect(duplicate.status).toBe(409);
    expect((await readJson(duplicate)).error.code).toBe("IBAN_IN_USE");
  });

  it("lets two different users hold the same IBAN", async () => {
    const payload = {
      name: "Tili",
      iban: "FI2112345600000785",
      openingBalance: 0,
      openingDate: "2026-01-01",
    };
    expect((await postAccount(payload)).status).toBe(201);
    expect((await postAccount(payload, otherCookie)).status).toBe(201);
  });

  it("allows several accounts without an IBAN", async () => {
    expect(
      (await postAccount({ name: "Käteiskassa", openingBalance: 0, openingDate: "2026-01-01" }))
        .status
    ).toBe(201);
    expect(
      (await postAccount({ name: "Toinen kassa", openingBalance: 0, openingDate: "2026-01-01" }))
        .status
    ).toBe(201);
    expect(await prisma.bankAccount.count({ where: { userId: user.id } })).toBe(2);
  });

  it("rejects fractional cents and malformed dates", async () => {
    const cents = await postAccount({
      name: "Tili",
      openingBalance: 10.005,
      openingDate: "2026-01-01",
    });
    expect(cents.status).toBe(400);

    const date = await postAccount({
      name: "Tili",
      openingBalance: 0,
      openingDate: "2026-02-30",
    });
    expect(date.status).toBe(400);
  });

  it("requires a session", async () => {
    const response = await createAccount(
      buildRequest("POST", "/api/bank-accounts", {
        name: "Tili",
        openingBalance: 0,
        openingDate: "2026-01-01",
      })
    );
    expect(response.status).toBe(401);
  });

  it("blocks cross-site submissions", async () => {
    const response = await createAccount(
      buildRequest(
        "POST",
        "/api/bank-accounts",
        { name: "Tili", openingBalance: 0, openingDate: "2026-01-01" },
        { cookie, secFetchSite: "cross-site" }
      )
    );
    expect(response.status).toBe(403);
    expect(await prisma.bankAccount.count()).toBe(0);
  });
});

describe("GET /api/bank-accounts", () => {
  it("returns positions per account and a combined total", async () => {
    const a = await createBankAccountRow(user.id, {
      name: "Käyttötili",
      openingBalanceCents: 100_00,
      openingDate: "2026-01-01",
      isDefault: true,
    });
    const b = await createBankAccountRow(user.id, {
      name: "Säästötili",
      openingBalanceCents: 5_000_00,
      openingDate: "2026-01-01",
    });
    await createStatementWithTransactions(user.id, {
      bankAccountId: a.id,
      transactions: [
        { date: "2026-01-10", amountCents: 500_00 },
        { date: "2026-01-20", amountCents: -150_00 },
      ],
    });

    const body = await readJson(
      await listAccounts(buildRequest("GET", "/api/bank-accounts", undefined, { cookie }))
    );

    expect(body.accounts).toHaveLength(2);
    const käyttö = body.accounts.find((x: JsonValue) => x.id === a.id);
    expect(käyttö).toMatchObject({
      currentBalance: 450,
      statementCount: 1,
      transactionCount: 2,
    });
    expect(body.accounts.find((x: JsonValue) => x.id === b.id).currentBalance).toBe(5000);
    expect(body.totalBalance).toBe(5450);
    expect(body.totalAccounts).toBe(2);
  });

  it("keeps a foreign-currency account out of the euro total", async () => {
    await createBankAccountRow(user.id, { openingBalanceCents: 100_00 });
    await createBankAccountRow(user.id, {
      name: "SEK-tili",
      currency: "SEK",
      openingBalanceCents: 900_00,
    });

    const body = await readJson(
      await listAccounts(buildRequest("GET", "/api/bank-accounts", undefined, { cookie }))
    );
    expect(body.totalBalance).toBe(100);
    expect(body.excludedCurrencies).toEqual(["SEK"]);
  });

  it("hides archived accounts unless asked", async () => {
    const archived = await createBankAccountRow(user.id, { name: "Vanha" });
    await prisma.bankAccount.update({
      where: { id: archived.id },
      data: { archivedAt: new Date() },
    });

    const hidden = await readJson(
      await listAccounts(buildRequest("GET", "/api/bank-accounts", undefined, { cookie }))
    );
    expect(hidden.accounts).toHaveLength(0);

    const shown = await readJson(
      await listAccounts(
        buildRequest("GET", "/api/bank-accounts?includeArchived=1", undefined, { cookie })
      )
    );
    expect(shown.accounts).toHaveLength(1);
    expect(shown.totalBalance).toBe(0); // archived money is not part of the position
  });

  it("never leaks another user's accounts", async () => {
    await createBankAccountRow(otherUser.id, { name: "Toisen tili" });
    const body = await readJson(
      await listAccounts(buildRequest("GET", "/api/bank-accounts", undefined, { cookie }))
    );
    expect(body.accounts).toEqual([]);
  });
});

describe("GET /api/bank-accounts/[id] - rollforward", () => {
  it("builds month rows from the account's own statements only", async () => {
    const account = await createBankAccountRow(user.id, {
      openingBalanceCents: 1_000_00,
      openingDate: "2026-01-01",
    });
    const otherAccount = await createBankAccountRow(user.id, { name: "Toinen" });

    await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      transactions: [
        { date: "2026-01-10", amountCents: 200_00 },
        { date: "2026-02-10", amountCents: -50_00 },
      ],
    });
    await createStatementWithTransactions(user.id, {
      bankAccountId: otherAccount.id,
      transactions: [{ date: "2026-01-11", amountCents: 999_00 }],
    });
    // An unassigned statement must not be attributed to any account.
    await createStatementWithTransactions(user.id, {
      bankAccountId: null,
      transactions: [{ date: "2026-01-12", amountCents: 777_00 }],
    });

    const body = await readJson(
      await getAccount(
        buildRequest("GET", `/api/bank-accounts/${account.id}?through=2026-03`, undefined, {
          cookie,
        }),
        routeContext({ id: account.id })
      )
    );

    expect(body.months.map((m: JsonValue) => m.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(body.months[0]).toMatchObject({ opening: 1000, income: 200, computedClosing: 1200 });
    expect(body.months[1]).toMatchObject({ opening: 1200, expense: 50, computedClosing: 1150 });
    expect(body.months[2]).toMatchObject({ txCount: 0, computedClosing: 1150 });
    expect(body.currentBalance).toBe(1150);
  });

  it("rejects a malformed through parameter", async () => {
    const account = await createBankAccountRow(user.id);
    const response = await getAccount(
      buildRequest("GET", `/api/bank-accounts/${account.id}?through=2026-13`, undefined, {
        cookie,
      }),
      routeContext({ id: account.id })
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 for another user's account instead of its data", async () => {
    const account = await createBankAccountRow(otherUser.id);
    const response = await getAccount(
      buildRequest("GET", `/api/bank-accounts/${account.id}`, undefined, { cookie }),
      routeContext({ id: account.id })
    );
    expect(response.status).toBe(404);
  });
});

describe("PUT/DELETE /api/bank-accounts/[id]/balances", () => {
  it("stores a reported balance and reconciles the month", async () => {
    const account = await createBankAccountRow(user.id, {
      openingBalanceCents: 0,
      openingDate: "2026-01-01",
    });
    await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      transactions: [{ date: "2026-01-10", amountCents: 300_00 }],
    });

    const put = await putBalance(
      buildRequest(
        "PUT",
        `/api/bank-accounts/${account.id}/balances`,
        { month: "2026-01", closingBalance: 300 },
        { cookie }
      ),
      routeContext({ id: account.id })
    );
    expect(put.status).toBe(200);

    const body = await readJson(
      await getAccount(
        buildRequest("GET", `/api/bank-accounts/${account.id}?through=2026-01`, undefined, {
          cookie,
        }),
        routeContext({ id: account.id })
      )
    );
    expect(body.months[0]).toMatchObject({
      reportedClosing: 300,
      difference: 0,
      status: "reconciled",
    });
    expect(body.mismatchMonths).toEqual([]);
  });

  it("surfaces the difference when the bank disagrees and anchors the next month", async () => {
    const account = await createBankAccountRow(user.id, {
      openingBalanceCents: 0,
      openingDate: "2026-01-01",
    });
    await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      transactions: [
        { date: "2026-01-10", amountCents: 300_00 },
        { date: "2026-02-10", amountCents: 10_00 },
      ],
    });

    await putBalance(
      buildRequest(
        "PUT",
        `/api/bank-accounts/${account.id}/balances`,
        { month: "2026-01", closingBalance: 350 },
        { cookie }
      ),
      routeContext({ id: account.id })
    );

    const body = await readJson(
      await getAccount(
        buildRequest("GET", `/api/bank-accounts/${account.id}?through=2026-02`, undefined, {
          cookie,
        }),
        routeContext({ id: account.id })
      )
    );
    expect(body.months[0]).toMatchObject({ difference: 50, status: "mismatch" });
    expect(body.months[1]).toMatchObject({ opening: 350, openingSource: "reported" });
    expect(body.mismatchMonths).toEqual(["2026-01"]);
  });

  it("overwrites an existing month instead of creating a second row", async () => {
    const account = await createBankAccountRow(user.id, { openingDate: "2026-01-01" });
    const url = `/api/bank-accounts/${account.id}/balances`;
    for (const closingBalance of [100, 220.25]) {
      await putBalance(
        buildRequest("PUT", url, { month: "2026-01", closingBalance }, { cookie }),
        routeContext({ id: account.id })
      );
    }
    const rows = await prisma.monthlyBalance.findMany({ where: { bankAccountId: account.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].closingBalanceCents).toBe(22025);
  });

  it("refuses a month before the account was opened", async () => {
    const account = await createBankAccountRow(user.id, { openingDate: "2026-03-01" });
    const response = await putBalance(
      buildRequest(
        "PUT",
        `/api/bank-accounts/${account.id}/balances`,
        { month: "2026-02", closingBalance: 10 },
        { cookie }
      ),
      routeContext({ id: account.id })
    );
    expect(response.status).toBe(400);
    expect(await prisma.monthlyBalance.count()).toBe(0);
  });

  it("rejects an invalid month key", async () => {
    const account = await createBankAccountRow(user.id);
    const response = await putBalance(
      buildRequest(
        "PUT",
        `/api/bank-accounts/${account.id}/balances`,
        { month: "2026-13", closingBalance: 10 },
        { cookie }
      ),
      routeContext({ id: account.id })
    );
    expect(response.status).toBe(400);
  });

  it("will not write a balance onto another user's account", async () => {
    const account = await createBankAccountRow(otherUser.id);
    const response = await putBalance(
      buildRequest(
        "PUT",
        `/api/bank-accounts/${account.id}/balances`,
        { month: "2026-01", closingBalance: 10 },
        { cookie }
      ),
      routeContext({ id: account.id })
    );
    expect(response.status).toBe(404);
    expect(await prisma.monthlyBalance.count()).toBe(0);
  });

  it("deletes a stored balance and 404s on the second attempt", async () => {
    const account = await createBankAccountRow(user.id, { openingDate: "2026-01-01" });
    await putBalance(
      buildRequest(
        "PUT",
        `/api/bank-accounts/${account.id}/balances`,
        { month: "2026-01", closingBalance: 10 },
        { cookie }
      ),
      routeContext({ id: account.id })
    );

    const first = await deleteBalance(
      buildRequest(
        "DELETE",
        `/api/bank-accounts/${account.id}/balances?month=2026-01`,
        undefined,
        { cookie }
      ),
      routeContext({ id: account.id })
    );
    expect(first.status).toBe(200);

    const second = await deleteBalance(
      buildRequest(
        "DELETE",
        `/api/bank-accounts/${account.id}/balances?month=2026-01`,
        undefined,
        { cookie }
      ),
      routeContext({ id: account.id })
    );
    expect(second.status).toBe(404);
  });
});

describe("PATCH / DELETE /api/bank-accounts/[id]", () => {
  it("updates fields and revalidates the IBAN", async () => {
    const account = await createBankAccountRow(user.id, { name: "Vanha nimi" });
    const ok = await patchAccount(
      buildRequest(
        "PATCH",
        `/api/bank-accounts/${account.id}`,
        { name: "Uusi nimi", iban: "FI7054000420152230", bankName: "OP" },
        { cookie }
      ),
      routeContext({ id: account.id })
    );
    expect(ok.status).toBe(200);
    expect((await readJson(ok)).account).toMatchObject({
      name: "Uusi nimi",
      iban: "FI7054000420152230",
      bankName: "OP",
    });

    const bad = await patchAccount(
      buildRequest("PATCH", `/api/bank-accounts/${account.id}`, { iban: "FI7054000420152231" }, {
        cookie,
      }),
      routeContext({ id: account.id })
    );
    expect(bad.status).toBe(400);
    const unchanged = await prisma.bankAccount.findUnique({ where: { id: account.id } });
    expect(unchanged?.iban).toBe("FI7054000420152230");
  });

  it("clears the IBAN when an empty string is sent", async () => {
    const account = await createBankAccountRow(user.id, { iban: "FI2112345600000785" });
    const response = await patchAccount(
      buildRequest("PATCH", `/api/bank-accounts/${account.id}`, { iban: "" }, { cookie }),
      routeContext({ id: account.id })
    );
    expect(response.status).toBe(200);
    expect((await readJson(response)).account.iban).toBeNull();
  });

  it("archiving drops the default flag", async () => {
    const account = await createBankAccountRow(user.id, { isDefault: true });
    const response = await patchAccount(
      buildRequest("PATCH", `/api/bank-accounts/${account.id}`, { archived: true }, { cookie }),
      routeContext({ id: account.id })
    );
    const { account: updated } = await readJson(response);
    expect(updated.archivedAt).not.toBeNull();
    expect(updated.isDefault).toBe(false);
  });

  it("rejects an empty patch body", async () => {
    const account = await createBankAccountRow(user.id);
    const response = await patchAccount(
      buildRequest("PATCH", `/api/bank-accounts/${account.id}`, {}, { cookie }),
      routeContext({ id: account.id })
    );
    expect(response.status).toBe(400);
  });

  it("deletes an empty account outright", async () => {
    const account = await createBankAccountRow(user.id);
    const response = await deleteAccount(
      buildRequest("DELETE", `/api/bank-accounts/${account.id}`, undefined, { cookie }),
      routeContext({ id: account.id })
    );
    expect((await readJson(response)).deleted).toBe(true);
    expect(await prisma.bankAccount.count()).toBe(0);
  });

  it("archives instead of deleting when statements would be orphaned", async () => {
    const account = await createBankAccountRow(user.id);
    await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      transactions: [{ date: "2026-01-10", amountCents: 100_00 }],
    });

    const body = await readJson(
      await deleteAccount(
        buildRequest("DELETE", `/api/bank-accounts/${account.id}`, undefined, { cookie }),
        routeContext({ id: account.id })
      )
    );
    expect(body).toMatchObject({ deleted: false, archived: true, statementCount: 1 });
    const stored = await prisma.bankAccount.findUnique({ where: { id: account.id } });
    expect(stored?.archivedAt).not.toBeNull();
    expect(await prisma.statement.count()).toBe(1);
  });

  it("cascades monthly balances when the account is deleted", async () => {
    const account = await createBankAccountRow(user.id, { openingDate: "2026-01-01" });
    await putBalance(
      buildRequest(
        "PUT",
        `/api/bank-accounts/${account.id}/balances`,
        { month: "2026-01", closingBalance: 10 },
        { cookie }
      ),
      routeContext({ id: account.id })
    );
    expect(await prisma.monthlyBalance.count()).toBe(1);

    await deleteAccount(
      buildRequest("DELETE", `/api/bank-accounts/${account.id}`, undefined, { cookie }),
      routeContext({ id: account.id })
    );
    expect(await prisma.monthlyBalance.count()).toBe(0);
  });

  it("will not touch another user's account", async () => {
    const account = await createBankAccountRow(otherUser.id, { name: "Toisen" });
    expect(
      (
        await patchAccount(
          buildRequest("PATCH", `/api/bank-accounts/${account.id}`, { name: "Kaapattu" }, {
            cookie,
          }),
          routeContext({ id: account.id })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await deleteAccount(
          buildRequest("DELETE", `/api/bank-accounts/${account.id}`, undefined, { cookie }),
          routeContext({ id: account.id })
        )
      ).status
    ).toBe(404);
    expect(await prisma.bankAccount.count({ where: { userId: otherUser.id } })).toBe(1);
  });
});
