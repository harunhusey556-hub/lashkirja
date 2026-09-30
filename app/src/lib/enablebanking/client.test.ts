import { describe, expect, it } from "vitest";
import {
  EnableBankingError,
  buildPsuHeaders,
  collectAccountTransactions,
  publicBankError,
  type TransactionPageFetcher,
} from "./client";
import type { EbTransaction } from "./mapping";

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

    const rows = await collectAccountTransactions(fetcher, {
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
    const rows = await collectAccountTransactions(fetcher, {
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

describe("publicBankError", () => {
  it("does not turn an upstream auth failure into a user logout", () => {
    expect(publicBankError(new EnableBankingError("nope", 401, "UNAUTHORIZED_ACCESS"))).toEqual({
      message: "Pankkiyhteyden tunnistautuminen epäonnistui. Tarkista sovelluksen avain ja APP_ID.",
      status: 502,
    });
    expect(publicBankError(new EnableBankingError("gone", 400, "EXPIRED_SESSION")).message).toBe(
      "Yhteys vanhentui — yhdistä uudelleen."
    );
  });
});
