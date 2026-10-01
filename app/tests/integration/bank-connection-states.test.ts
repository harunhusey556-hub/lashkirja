/**
 * Live-use test 2026-09-30 (G31 G32 G33 G34 G35): what the owner sees when a
 * bank connection ends, is replaced, fails to start, fails to sync or is
 * disconnected. One calm sentence each, never a vanished or ghost connection,
 * and never a claim the bank did not confirm.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/encryption";
import { EnableBankingError, type EnableBankingClient } from "@/lib/enablebanking/client";
import {
  completeBankConsent,
  listBankConnections,
  revokeBankConnection,
  startBankConsent,
} from "@/lib/enablebanking/connect";
import { createAuthState, hashAuthState } from "@/lib/enablebanking/consent";
import { syncBankConnection } from "@/lib/enablebanking/sync";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";

const IBAN_A = "FI2112345600000785";
const IBAN_B = "FI4950009420028730";
let user: TestUser;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
});

async function connection(
  data: Partial<{
    status: string;
    lastError: string | null;
    sessionIdEnc: string | null;
    aspspName: string;
    inScope: boolean;
    createdAt: Date;
    accounts: Array<{ iban: string; uid: string; inScope: boolean }>;
  }> = {}
) {
  const accounts = data.accounts ?? [{ iban: IBAN_A, uid: "acc-1", inScope: data.inScope ?? true }];
  return prisma.bankConnection.create({
    data: {
      userId: user.id,
      aspspName: data.aspspName ?? "S-Pankki",
      aspspCountry: "FI",
      psuType: "business",
      status: data.status ?? "active",
      sessionIdEnc: data.sessionIdEnc === undefined ? encrypt("session-1") : data.sessionIdEnc,
      validUntil: new Date("2099-01-01T00:00:00.000Z"),
      lastError: data.lastError ?? null,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      accounts: {
        create: accounts.map((account) => ({
          userId: user.id,
          iban: account.iban,
          label: "Käyttötili",
          providerAccountUid: account.uid,
          inScope: account.inScope,
        })),
      },
    },
  });
}

const stub = (parts: Record<string, unknown>) => parts as unknown as EnableBankingClient;

describe("G31: a consent the bank withdrew stays a visible, reconnectable connection", () => {
  it("a session check answering REVOKED_SESSION ends as expired with its own reason", async () => {
    const row = await connection();
    const client = stub({
      getSession: async () => {
        throw new EnableBankingError("revoked", 403, "REVOKED_SESSION");
      },
    });
    await expect(syncBankConnection(user.id, row.id, { attended: false, client })).rejects.toMatchObject({
      status: 409,
      code: "REVOKED_SESSION",
      message: "Pankki on peruuttanut luvan.",
    });

    const stored = await prisma.bankConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.status).toBe("expired");
    expect(stored.lastError).toBe("Pankki on peruuttanut luvan.");
    const listed = await listBankConnections(user.id);
    expect(listed.map((item) => item.id)).toEqual([row.id]);
  });

  it("a session reporting status REVOKED ends the same way", async () => {
    const row = await connection();
    const client = stub({ getSession: async () => ({ status: "REVOKED" }) });
    await expect(syncBankConnection(user.id, row.id, { attended: false, client })).rejects.toMatchObject({
      code: "REVOKED_SESSION",
    });
    const stored = await prisma.bankConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.status).toBe("expired");
    expect(stored.lastError).toBe("Pankki on peruuttanut luvan.");
  });

  it("a revoked-at-the-bank row an earlier version hid comes back as a reconnect case", async () => {
    const hidden = await connection({ status: "revoked", sessionIdEnc: null, lastError: "Yhteys vanhentui — yhdistä uudelleen." });
    const own = await connection({ status: "revoked", sessionIdEnc: null, lastError: null, aspspName: "OP" });
    const listed = await listBankConnections(user.id);
    expect(listed.map((item) => item.id)).toEqual([hidden.id]);
    expect(listed[0].status).toBe("expired");
    expect(await prisma.bankConnection.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ status: "revoked" });
  });
});

describe("G33: a failed attempt leaves nothing behind and shows no operator text", () => {
  const aspsp = { name: "S-Pankki", country: "FI", psu_types: ["business"] };

  it("a start the bank refused is not a connection", async () => {
    const client = stub({
      listAspsps: async () => [aspsp],
      startAuthorization: async () => {
        throw new EnableBankingError("bad redirect", 400, "REDIRECT_URI_NOT_ALLOWED");
      },
    });
    await expect(
      startBankConsent(user.id, { aspspName: "S-Pankki", aspspCountry: "FI", psuType: "business" }, client)
    ).rejects.toBeInstanceOf(EnableBankingError);

    expect(await listBankConnections(user.id)).toEqual([]);
  });

  it("an abandoned attempt, a replaced attempt and an old ghost never list as connections", async () => {
    await connection({ status: "pending", sessionIdEnc: null, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), accounts: [] });
    await connection({ status: "error", sessionIdEnc: null, lastError: "Ohjausosoite ei ole sallittu. Tarkista ENABLEBANKING_REDIRECT_URL.", accounts: [] });
    const real = await connection({ aspspName: "OP" });
    const listed = await listBankConnections(user.id);
    expect(listed.map((item) => item.id)).toEqual([real.id]);
  });

  it("a callback that fails leaves no 'needs reconfirmation' card", async () => {
    const state = createAuthState();
    await prisma.bankConnection.create({
      data: {
        userId: user.id,
        aspspName: "S-Pankki",
        aspspCountry: "FI",
        psuType: "business",
        status: "pending",
        authStateHash: hashAuthState(state),
      },
    });
    const client = stub({
      authorizeSession: async () => {
        throw new EnableBankingError("denied", 400, "ACCESS_DENIED");
      },
    });
    await expect(completeBankConsent(user.id, "code", state, client)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(await listBankConnections(user.id)).toEqual([]);
  });

  it("a sync the bank refused with 401 stores and throws Finnish, not the provider's text", async () => {
    const row = await connection();
    const client = stub({
      getSession: async () => {
        throw new EnableBankingError("Forbidden", 403, "FORBIDDEN");
      },
    });
    const error = await syncBankConnection(user.id, row.id, { attended: false, client }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnableBankingError);
    expect((error as Error).message).not.toMatch(/Forbidden|APP_ID|avain/);
    const job = await prisma.backgroundJob.findFirst({ where: { userId: user.id } });
    expect(job?.error ?? "").not.toMatch(/Forbidden/);
  });
});

describe("G32: reconnecting replaces the expired connection and keeps the chosen accounts", () => {
  async function pendingConsent() {
    const state = createAuthState();
    const row = await prisma.bankConnection.create({
      data: {
        userId: user.id,
        aspspName: "S-Pankki",
        aspspCountry: "FI",
        psuType: "business",
        status: "pending",
        authStateHash: hashAuthState(state),
      },
    });
    return { state, row };
  }
  const session = {
    session_id: "session-2",
    accounts: [
      { uid: "new-1", name: "Käyttötili", currency: "EUR", account_id: { iban: IBAN_A } },
      { uid: "new-2", name: "Säästötili", currency: "EUR", account_id: { iban: IBAN_B } },
    ],
    access: { valid_until: "2099-01-01T00:00:00.000Z" },
  };

  it("retires the old connection and ticks the accounts the owner had chosen", async () => {
    const old = await connection({
      status: "expired",
      sessionIdEnc: null,
      lastError: "Yhteys vanhentui — yhdistä uudelleen.",
      accounts: [
        { iban: IBAN_A, uid: "old-1", inScope: true },
        { iban: IBAN_B, uid: "old-2", inScope: false },
      ],
    });
    const { state, row } = await pendingConsent();
    const client = stub({ authorizeSession: async () => session });

    const fresh = await completeBankConsent(user.id, "code", state, client);
    expect(fresh.id).toBe(row.id);
    expect(fresh.accounts.map((account) => [account.iban.replace(/\s/g, ""), account.inScope])).toEqual([
      [IBAN_A, true],
      [IBAN_B, false],
    ]);

    const listed = await listBankConnections(user.id);
    expect(listed.map((item) => item.id)).toEqual([row.id]);
    expect(await prisma.bankConnection.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: "revoked", sessionIdEnc: null });
  });

  it("keeps the old card when the reconnect does not succeed", async () => {
    const old = await connection({ status: "expired", sessionIdEnc: null, lastError: "Yhteys vanhentui — yhdistä uudelleen." });
    const { state } = await pendingConsent();
    const client = stub({
      authorizeSession: async () => {
        throw new EnableBankingError("denied", 400, "ACCESS_DENIED");
      },
    });
    await expect(completeBankConsent(user.id, "code", state, client)).rejects.toBeInstanceOf(EnableBankingError);
    expect((await listBankConnections(user.id)).map((item) => item.id)).toEqual([old.id]);
  });

  it("leaves a live connection of the same bank alone", async () => {
    const live = await connection({ accounts: [{ iban: IBAN_B, uid: "live-1", inScope: true }] });
    const { state } = await pendingConsent();
    const client = stub({ authorizeSession: async () => session });
    await completeBankConsent(user.id, "code", state, client);
    const ids = (await listBankConnections(user.id)).map((item) => item.id);
    expect(ids).toContain(live.id);
    expect(ids).toHaveLength(2);
  });

  it("a new attempt for a bank replaces the earlier waiting one without a ghost", async () => {
    const waiting = await connection({ status: "pending", sessionIdEnc: null, accounts: [] });
    const client = stub({
      listAspsps: async () => [{ name: "S-Pankki", country: "FI", psu_types: ["business"] }],
      startAuthorization: async () => ({ url: "https://bank.example/auth" }),
    });
    await startBankConsent(user.id, { aspspName: "S-Pankki", aspspCountry: "FI", psuType: "business" }, client);
    const listed = await listBankConnections(user.id);
    expect(listed.map((item) => item.id)).not.toContain(waiting.id);
    expect(listed.every((item) => item.status === "pending")).toBe(true);
  });
});

describe("G34: one calm message per bank failure, and a 429 keeps its meaning", () => {
  function transactionsFail(error: EnableBankingError) {
    return stub({
      getSession: async () => ({ status: "AUTHORIZED" }),
      getAccountBalances: async () => [],
      getAccountTransactions: async () => {
        throw error;
      },
    });
  }

  it("a bank 429 is told as a request to wait, with status 429", async () => {
    const row = await connection();
    const client = transactionsFail(new EnableBankingError("slow down", 429, "ASPSP_RATE_LIMIT_EXCEEDED"));
    await expect(syncBankConnection(user.id, row.id, { attended: false, client })).rejects.toMatchObject({
      status: 429,
      message: "Pankki pyytää odottamaan. Yritä hetken päästä uudelleen.",
    });
    const stored = await prisma.bankConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.lastError).toBe("Pankki pyytää odottamaan. Yritä hetken päästä uudelleen.");
  });

  it("a bank 500 is one generic sentence, the same in the answer and in the card", async () => {
    const row = await connection();
    const client = transactionsFail(new EnableBankingError("boom", 500));
    const error = (await syncBankConnection(user.id, row.id, { attended: false, client }).catch((e: unknown) => e)) as EnableBankingError;
    const stored = await prisma.bankConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(error.message).toBe("Pankkiyhteys epäonnistui. Yritä uudelleen.");
    expect(stored.lastError).toBe(error.message);
  });
});

describe("G35: a disconnect is told as done only when the bank closed the session", () => {
  it("a bank that refuses the delete leaves the connection revocable and says so", async () => {
    const row = await connection();
    const refuse = stub({
      deleteSession: async () => {
        throw new EnableBankingError("boom", 500);
      },
    });
    await expect(revokeBankConnection(user.id, row.id, null, refuse)).rejects.toMatchObject({
      message: "Pankkia ei tavoitettu, joten yhteyttä ei katkaistu. Yritä hetken päästä uudelleen.",
    });
    const kept = await prisma.bankConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(kept.status).toBe("active");
    expect(kept.sessionIdEnc && decrypt(kept.sessionIdEnc)).toBe("session-1");

    let closed = "";
    const accept = stub({
      deleteSession: async (id: string) => {
        closed = id;
      },
    });
    await revokeBankConnection(user.id, row.id, null, accept);
    expect(closed).toBe("session-1");
    const done = await prisma.bankConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(done).toMatchObject({ status: "revoked", sessionIdEnc: null });
  });

  it("a session the bank no longer knows is closed already, so the disconnect goes through", async () => {
    const row = await connection();
    const gone = stub({
      deleteSession: async () => {
        throw new EnableBankingError("gone", 404, "SESSION_DOES_NOT_EXIST");
      },
    });
    await revokeBankConnection(user.id, row.id, null, gone);
    expect(await prisma.bankConnection.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "revoked", sessionIdEnc: null });
  });
});
