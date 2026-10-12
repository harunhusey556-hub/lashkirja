import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as createConnection } from "@/app/api/bank/connections/route";
import { completeBankConsent, startBankConsent } from "@/lib/enablebanking/connect";
import { hashAuthState, isPendingStateFresh } from "@/lib/enablebanking/consent";
import { APP_BANK_STATE_PREFIX, isAppBankState } from "@/lib/bank-return";
import type { EbAspsp, EbSession } from "@/lib/enablebanking/client";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

const ASPSP: EbAspsp = {
  name: "Testipankki",
  country: "FI",
  psu_types: ["personal", "business"],
  maximum_consent_validity: 15552000,
  required_psu_headers: [],
};

/** ENABLEBANKING_ENABLED=false in the test env (.env), so the route always
 * answers 503 before it can reach startBankConsent. Exercise the pure
 * consent flow directly with a fake client, the same pattern
 * wave-g-bank-reports.test.ts uses for the sync side. */
function fakeClient(capture: { state?: string }) {
  return {
    listAspsps: async () => [ASPSP],
    startAuthorization: async (input: { state: string }) => {
      capture.state = input.state;
      return { url: "https://bank.example/authorize" };
    },
    authorizeSession: async (): Promise<EbSession> => ({
      session_id: "session-1",
      accounts: [
        {
          uid: "acc-1",
          name: "Käyttötili",
          currency: "EUR",
          account_id: { iban: "FI2112345600000785" },
        },
      ],
      access: { valid_until: "2027-01-01T00:00:00.000Z" },
    }),
  } as never;
}

describe("Enable Banking disabled: the route stays 503 regardless of client", () => {
  it("POST /api/bank/connections with client: app still 503s (Enable Banking is off in tests)", async () => {
    const response = await createConnection(
      buildRequest(
        "POST",
        "/api/bank/connections",
        { aspspName: "Testipankki", aspspCountry: "FI", psuType: "personal", client: "app" },
        { cookie }
      )
    );
    expect(response.status).toBe(503);
    const body = await readJson<{ error: string }>(response);
    expect(body.error).toMatch(/ei ole käytössä/);
  });
});

describe("startBankConsent with client: app", () => {
  it("stores the hash of a state carrying the app1. prefix", async () => {
    const capture: { state?: string } = {};
    const { connectionId } = await startBankConsent(
      user.id,
      { aspspName: "Testipankki", aspspCountry: "FI", psuType: "personal", client: "app" },
      fakeClient(capture)
    );

    expect(capture.state).toBeDefined();
    expect(isAppBankState(capture.state)).toBe(true);
    expect(capture.state).toMatch(new RegExp(`^${APP_BANK_STATE_PREFIX.replace(".", "\\.")}[0-9a-f]{64}$`));

    const connection = await prisma.bankConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(connection.status).toBe("pending");
    expect(connection.authStateHash).toBe(hashAuthState(capture.state!));
    expect(isPendingStateFresh(connection.createdAt)).toBe(true);
  });

  it("defaults to a plain state with no prefix when client is omitted", async () => {
    const capture: { state?: string } = {};
    await startBankConsent(
      user.id,
      { aspspName: "Testipankki", aspspCountry: "FI", psuType: "personal" },
      fakeClient(capture)
    );
    expect(isAppBankState(capture.state)).toBe(false);
    expect(capture.state).toMatch(/^[0-9a-f]{64}$/);
  });

  it("completes the consent when the callback state carries the app prefix", async () => {
    const capture: { state?: string } = {};
    await startBankConsent(
      user.id,
      { aspspName: "Testipankki", aspspCountry: "FI", psuType: "personal", client: "app" },
      fakeClient(capture)
    );
    const state = capture.state!;

    const client = fakeClient(capture);
    const connection = await completeBankConsent(user.id, "auth-code-1", state, client);

    expect(connection.status).toBe("active");
    const stored = await prisma.bankConnection.findUniqueOrThrow({
      where: { id: connection.id },
      include: { accounts: true },
    });
    expect(stored.status).toBe("active");
    expect(stored.accounts).toHaveLength(1);
    expect(stored.accounts[0].iban).toBe("FI2112345600000785");
  });

  it("reads the accounts from the session when authorize lists none (Holvi, 2026-10-09)", async () => {
    const capture: { state?: string } = {};
    await startBankConsent(user.id, { aspspName: "Testipankki", aspspCountry: "FI", psuType: "business" }, fakeClient(capture));
    const asked: string[] = [];
    const client = {
      authorizeSession: async (): Promise<EbSession> => ({ session_id: "session-h", accounts: [], access: { valid_until: "2027-01-01T00:00:00.000Z" } }),
      getSession: async () => ({ status: "AUTHORIZED", accounts: ["holvi-acc"] }),
      getAccountDetails: async (uid: string) => {
        asked.push(uid);
        return { name: "Holvi", currency: "EUR", account_id: { iban: "FI21 1234 5600 0007 85" } };
      },
    } as never;
    const connection = await completeBankConsent(user.id, "auth-code-h", capture.state!, client);
    expect(connection.status).toBe("active");
    expect(asked).toEqual(["holvi-acc"]);
    const stored = await prisma.connectedAccount.findMany({ where: { connectionId: connection.id } });
    expect(stored.map((account) => [account.providerAccountUid, account.iban])).toEqual([["holvi-acc", "FI2112345600000785"]]);
  });
});

describe("reconnect before the old connection was marked expired (audit 2026-10-09)", () => {
  it("keeps the accounts the owner chose and retires the old card", async () => {
    const old = await prisma.bankConnection.create({
      data: {
        userId: user.id, aspspName: "Testipankki", aspspCountry: "FI", psuType: "personal", status: "active",
        validUntil: new Date(Date.now() - 60_000),
        accounts: { create: [{ userId: user.id, iban: "FI2112345600000785", label: "Käyttötili", providerAccountUid: "old-acc", inScope: true }] },
      },
    });
    const capture: { state?: string } = {};
    await startBankConsent(user.id, { aspspName: "Testipankki", aspspCountry: "FI", psuType: "personal" }, fakeClient(capture));
    const renewed = await completeBankConsent(user.id, "auth-code-r", capture.state!, fakeClient(capture));
    const accounts = await prisma.connectedAccount.findMany({ where: { connectionId: renewed.id } });
    expect(accounts.map((account) => account.inScope)).toEqual([true]);
    expect((await prisma.bankConnection.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("revoked");
  });
});
