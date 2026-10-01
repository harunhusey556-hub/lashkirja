import { generateKeyPairSync } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EnableBankingClient,
  EnableBankingError,
  MAX_TRANSACTION_PAGES,
  buildPsuHeaders,
  collectAccountTransactions,
  publicBankError,
  type TransactionPageFetcher,
} from "./client";
import type { EbTransaction } from "./mapping";
import type { EnableBankingConfig } from "./signing";

const booked: EbTransaction = {
  status: "BOOK",
  entry_reference: "1",
  credit_debit_indicator: "CRDT",
  transaction_amount: { currency: "EUR", amount: "1.00" },
  booking_date: "2026-09-01",
};

describe("buildPsuHeaders", () => {
  it("sends every required header or none", () => {
    expect(buildPsuHeaders([], { ipAddress: "127.0.0.1" })).toEqual({ headers: {} });
    expect(buildPsuHeaders(["Psu-Ip-Address"], null)).toEqual({ headers: {} });
    expect(
      buildPsuHeaders(["Psu-Ip-Address", "Psu-User-Agent"], {
        ipAddress: "203.0.113.5",
        userAgent: "LashKirja",
      })
    ).toEqual({
      headers: { "Psu-Ip-Address": "203.0.113.5", "Psu-User-Agent": "LashKirja" },
    });
    expect(
      buildPsuHeaders(["Psu-Ip-Address", "Psu-Geo-Location"], { ipAddress: "203.0.113.5" })
    ).toEqual({ missing: ["Psu-Geo-Location"] });
  });
});

describe("collectAccountTransactions", () => {
  it("retries without strategy when the bank rejects longest", async () => {
    const calls: Array<string | undefined> = [];
    const fetcher: TransactionPageFetcher = {
      async getAccountTransactions(query) {
        calls.push(query.strategy);
        if (query.strategy === "longest") {
          throw new EnableBankingError(
            "strategy is not supported",
            400,
            "WRONG_REQUEST_PARAMETERS"
          );
        }
        if (query.continuationKey) {
          return { transactions: [], continuationKey: null };
        }
        return {
          transactions: [booked],
          continuationKey: "next",
        };
      },
    };

    const { transactions: rows } = await collectAccountTransactions(fetcher, {
      accountUid: "acc-1",
      firstSync: true,
      now: new Date("2026-09-26T00:00:00.000Z"),
    });
    expect(calls[0]).toBe("longest");
    expect(calls.at(-1)).toBeUndefined();
    expect(rows).toEqual([booked]);
  });

  it("starts the first sync from the owner's chosen day, not the whole history", async () => {
    const queries: Array<{ strategy?: string; dateFrom?: string; dateTo?: string }> = [];
    const fetcher: TransactionPageFetcher = {
      async getAccountTransactions(query) {
        queries.push({ strategy: query.strategy, dateFrom: query.dateFrom, dateTo: query.dateTo });
        return { transactions: [booked], continuationKey: null };
      },
    };
    const { transactions: rows } = await collectAccountTransactions(fetcher, {
      accountUid: "acc-1",
      firstSync: true,
      historyFrom: "2026-01-01",
      now: new Date("2026-09-26T00:00:00.000Z"),
    });
    expect(queries).toEqual([{ strategy: undefined, dateFrom: "2026-01-01", dateTo: "2026-09-26" }]);
    expect(rows).toEqual([booked]);
  });

  it("never falls back further than the chosen day", async () => {
    const froms: Array<string | undefined> = [];
    const fetcher: TransactionPageFetcher = {
      async getAccountTransactions(query) {
        froms.push(query.dateFrom);
        if (froms.length === 1) {
          throw new EnableBankingError("period", 422, "WRONG_TRANSACTIONS_PERIOD");
        }
        return { transactions: [booked], continuationKey: null };
      },
    };
    await collectAccountTransactions(fetcher, {
      accountUid: "acc-1",
      firstSync: true,
      historyFrom: "2026-09-01",
      now: new Date("2026-09-26T00:00:00.000Z"),
    });
    expect(froms.every((from) => from !== undefined && from >= "2026-09-01")).toBe(true);
  });

  it("does not retry a dead session", async () => {
    const fetcher: TransactionPageFetcher = {
      async getAccountTransactions() {
        throw new EnableBankingError("gone", 401, "EXPIRED_SESSION");
      },
    };
    await expect(
      collectAccountTransactions(fetcher, { accountUid: "acc-1", firstSync: true })
    ).rejects.toMatchObject({ code: "EXPIRED_SESSION" });
  });
});

function pagedFetcher(pages: number, perPage = 2): TransactionPageFetcher & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async getAccountTransactions(query) {
      calls += 1;
      const page = query.continuationKey ? Number(query.continuationKey) : 0;
      const rows = Array.from({ length: perPage }, (_, index) => ({
        ...booked,
        entry_reference: `p${page}-${index}`,
      }));
      return { transactions: rows, continuationKey: page + 1 < pages ? String(page + 1) : null };
    },
  };
}

describe("collectAccountTransactions paging", () => {
  it("pages past 100 until the bank has no continuation key (G27)", async () => {
    const fetcher = pagedFetcher(250);
    const result = await collectAccountTransactions(fetcher, {
      accountUid: "acc-1",
      firstSync: true,
      now: new Date("2026-09-26T00:00:00.000Z"),
    });
    expect(result.truncated).toBe(false);
    expect(result.transactions).toHaveLength(500);
    expect(fetcher.calls()).toBe(250);
  });

  it("reports a pull that hits the safety ceiling instead of ending it silently (G27)", async () => {
    const fetcher = pagedFetcher(MAX_TRANSACTION_PAGES + 50);
    const result = await collectAccountTransactions(fetcher, {
      accountUid: "acc-1",
      firstSync: true,
      now: new Date("2026-09-26T00:00:00.000Z"),
    });
    expect(result.truncated).toBe(true);
    expect(result.transactions).toHaveLength(MAX_TRANSACTION_PAGES * 2);
  });

  it("reports a bank that keeps answering with the same continuation key (G27)", async () => {
    const fetcher: TransactionPageFetcher = {
      async getAccountTransactions() {
        return { transactions: [booked], continuationKey: "same" };
      },
    };
    const result = await collectAccountTransactions(fetcher, {
      accountUid: "acc-1",
      firstSync: true,
      now: new Date("2026-09-26T00:00:00.000Z"),
    });
    expect(result.truncated).toBe(true);
  });
});

describe("EnableBankingClient response handling (G28)", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config: EnableBankingConfig = {
    appId: "app-1",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    redirectUrl: "https://example.test/cb",
    apiBase: "https://api.example.test",
  };
  afterEach(() => vi.unstubAllGlobals());

  function answerWith(pages: Array<{ status?: number; body: string }>) {
    let index = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const page = pages[Math.min(index, pages.length - 1)];
        index += 1;
        const status = page.status ?? 200;
        return new Response(status === 204 ? null : page.body, { status });
      })
    );
  }

  const goodPage = (key: string | null) =>
    JSON.stringify({ transactions: [booked], continuation_key: key });
  const badBodies: Array<[string, string]> = [
    ["truncated json", '{"transactions":[{"status":"BO'],
    ["an html page", "<html><body>Service unavailable</body></html>"],
    ["an empty body", ""],
    ["an array", "[]"],
    ["json without a transactions array", '{"message":"hello"}'],
    ["a non-string continuation key", '{"transactions":[],"continuation_key":7}'],
  ];

  for (const [label, body] of badBodies) {
    it(`fails the pull on a 200 with ${label}, on the first and on a later page`, async () => {
      for (const pages of [[{ body }], [{ body: goodPage("2") }, { body }]]) {
        answerWith(pages);
        const client = new EnableBankingClient(config);
        await expect(
          collectAccountTransactions(client, {
            accountUid: "acc-1",
            firstSync: true,
            now: new Date("2026-09-26T00:00:00.000Z"),
          })
        ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 502 });
      }
    });
  }

  it("still reads a genuinely empty page", async () => {
    answerWith([{ body: '{"transactions":[]}' }]);
    const client = new EnableBankingClient(config);
    const result = await collectAccountTransactions(client, {
      accountUid: "acc-1",
      firstSync: true,
      now: new Date("2026-09-26T00:00:00.000Z"),
    });
    expect(result).toEqual({ transactions: [], truncated: false });
  });

  it("lets a session delete answer with an empty body", async () => {
    answerWith([{ status: 204, body: "" }]);
    await expect(new EnableBankingClient(config).deleteSession("s-1")).resolves.toBeUndefined();
  });
});

describe("publicBankError", () => {
  it("does not turn an upstream auth failure into a user logout", () => {
    expect(publicBankError(new EnableBankingError("nope", 401, "UNAUTHORIZED_ACCESS"))).toEqual({
      message: "Pankkiyhteyden tunnistautuminen epäonnistui. Yritä myöhemmin uudelleen.",
      status: 502,
    });
    expect(publicBankError(new EnableBankingError("gone", 400, "EXPIRED_SESSION")).message).toBe(
      "Yhteys vanhentui. Yhdistä uudelleen."
    );
  });

  it("G33: no setting or env-var name ever reaches the person using the app", () => {
    const failures = [
      new EnableBankingError("redirect", 400, "REDIRECT_URI_NOT_ALLOWED"),
      new EnableBankingError("Forbidden", 403),
      new EnableBankingError("nope", 401, "UNAUTHORIZED_ACCESS"),
      new EnableBankingError("boom", 500),
    ];
    for (const failure of failures) {
      const { message } = publicBankError(failure);
      expect(message).not.toMatch(/ENABLEBANKING|APP_ID|Control Panel|avain|Enable Banking|Forbidden/i);
    }
    expect(publicBankError(failures[0]).message).toBe("Pankkiyhteyttä ei voitu avata. Yritä myöhemmin uudelleen.");
  });

  it("G34: a bank 429 keeps its meaning, however it is reported", () => {
    const calm = "Pankki pyytää odottamaan. Yritä hetken päästä uudelleen.";
    expect(publicBankError(new EnableBankingError("x", 429, "ASPSP_RATE_LIMIT_EXCEEDED"))).toEqual({ message: calm, status: 429 });
    expect(publicBankError(new EnableBankingError("x", 429))).toEqual({ message: calm, status: 429 });
  });

  it("G31: a withdrawn consent says so, and an expired one still says expired", () => {
    expect(publicBankError(new EnableBankingError("x", 403, "REVOKED_SESSION")).message).toBe("Pankki on peruuttanut luvan.");
    expect(publicBankError(new EnableBankingError("x", 403, "EXPIRED_SESSION")).message).toBe("Yhteys vanhentui. Yhdistä uudelleen.");
  });

  it("explains an unreadable bank answer in plain Finnish", () => {
    expect(publicBankError(new EnableBankingError("x", 502, "INVALID_RESPONSE")).message).toBe(
      "Pankin vastausta ei voitu lukea. Yritä uudelleen."
    );
  });
});

describe("R55: a first sync whose window the bank shortened says so", () => {
  const now = new Date("2026-09-26T00:00:00.000Z");
  const rejectBefore = (earliest: string): TransactionPageFetcher => ({
    async getAccountTransactions(query) {
      if (query.dateFrom && query.dateFrom < earliest) {
        throw new EnableBankingError("period", 422, "WRONG_TRANSACTIONS_PERIOD");
      }
      return { transactions: [booked], continuationKey: null };
    },
  });

  it("reports where the successful window began when it starts after the chosen day", async () => {
    const result = await collectAccountTransactions(rejectBefore("2026-06-01"), {
      accountUid: "acc-1",
      firstSync: true,
      historyFrom: "2025-01-01",
      now,
    });
    expect(result.truncated).toBe(false);
    expect(result.shortenedFrom).toBe("2026-06-28");
  });

  it("says nothing when the chosen day itself was served", async () => {
    const result = await collectAccountTransactions(rejectBefore("2020-01-01"), {
      accountUid: "acc-1",
      firstSync: true,
      historyFrom: "2026-01-01",
      now,
    });
    expect(result.shortenedFrom).toBeUndefined();
  });

  it("says nothing when the fallback window is clamped to the chosen day", async () => {
    const result = await collectAccountTransactions(rejectBefore("2026-01-01"), {
      accountUid: "acc-1",
      firstSync: true,
      historyFrom: "2026-09-01",
      now,
    });
    expect(result.shortenedFrom).toBeUndefined();
  });

  it("reports the year window when the bank refuses to give all of its history", async () => {
    const fetcher: TransactionPageFetcher = {
      async getAccountTransactions(query) {
        if (query.strategy === "longest") {
          throw new EnableBankingError("strategy is not supported", 400, "WRONG_REQUEST_PARAMETERS");
        }
        return { transactions: [booked], continuationKey: null };
      },
    };
    const result = await collectAccountTransactions(fetcher, { accountUid: "acc-1", firstSync: true, now });
    expect(result.shortenedFrom).toBe("2025-09-26");
  });

  it("an incremental pull that was served as asked is not shortened", async () => {
    const result = await collectAccountTransactions(rejectBefore("2020-01-01"), {
      accountUid: "acc-1",
      firstSync: false,
      dateFrom: "2026-09-20",
      now,
    });
    expect(result.shortenedFrom).toBeUndefined();
  });
});

describe("R65: a pull has a time budget", () => {
  it("ends as truncated when the budget is used up, with what was read", async () => {
    let calls = 0;
    const fetcher: TransactionPageFetcher = {
      async getAccountTransactions() {
        calls += 1;
        return { transactions: [booked], continuationKey: `k${calls}` };
      },
    };
    const result = await collectAccountTransactions(fetcher, { accountUid: "acc-1", firstSync: true, budgetMs: -1 });
    expect(result.truncated).toBe(true);
    expect(calls).toBe(1);
    expect(result.transactions).toHaveLength(1);
  });
});
