import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  convertToEuros,
  euroConversion,
  getEurRate,
  setFxFetcherForTests,
  setFxStoreForTests,
  storedFxRate,
  unconvertedForeignTotal,
  type EurRate,
  type FxFetcher,
} from "./fx-rates";
import { fxRateLine } from "./foreign-purchase";
import { normalizeAIResult } from "./ai";

const memory = new Map<string, EurRate>();

function fakeEcb(): { fetcher: FxFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: FxFetcher = async (url) => {
    calls.push(url);
    const asked = url.split("/").pop()!.slice(0, 10);
    // The ECB publishes on business days only: a weekend answers with the Friday before.
    const date = asked === "2026-07-12" ? "2026-07-10" : asked;
    return { ok: true, status: 200, json: async () => ({ amount: 1, base: "USD", date, rates: { EUR: 0.9123 } }) };
  };
  return { fetcher, calls };
}

beforeEach(() => {
  memory.clear();
  setFxStoreForTests({
    get: async (currency, date) => memory.get(`${currency}|${date}`) ?? null,
    put: async (currency, date, value) => void memory.set(`${currency}|${date}`, value),
  });
});

afterEach(() => {
  setFxFetcherForTests(null);
  setFxStoreForTests(null);
  vi.unstubAllEnvs();
});

describe("getEurRate", () => {
  it("returns the previous business day's rate for a weekend date", async () => {
    const { fetcher, calls } = fakeEcb();
    setFxFetcherForTests(fetcher);
    // 2026-07-12 is a Sunday.
    expect(await getEurRate("usd", "2026-07-12")).toEqual({ rate: 0.9123, rateDate: "2026-07-10" });
    expect(calls).toEqual(["https://api.frankfurter.app/2026-07-12?from=USD&to=EUR"]);
  });

  it("answers a repeat from the cache without asking the ECB again", async () => {
    const { fetcher, calls } = fakeEcb();
    setFxFetcherForTests(fetcher);
    await getEurRate("USD", "2026-07-10");
    await getEurRate("USD", "2026-07-10");
    expect(calls).toHaveLength(1);
  });

  it("is null, never a throw, when the network fails or times out", async () => {
    setFxFetcherForTests(async () => {
      throw new Error("offline");
    });
    expect(await getEurRate("USD", "2026-07-10")).toBeNull();
    setFxFetcherForTests(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    expect(await getEurRate("XXX", "2026-07-10")).toBeNull();
    setFxFetcherForTests(async () => ({ ok: true, status: 200, json: async () => ({ date: "2026-07-10", rates: {} }) }));
    expect(await getEurRate("USD", "2026-07-10")).toBeNull();
  });

  it("does not look up euros, bad codes, or anything when switched off", async () => {
    const { fetcher, calls } = fakeEcb();
    setFxFetcherForTests(fetcher);
    expect(await getEurRate("EUR", "2026-07-10")).toBeNull();
    expect(await getEurRate("US", "2026-07-10")).toBeNull();
    vi.stubEnv("FX_RATES_ENABLED", "false");
    expect(await getEurRate("USD", "2026-07-10")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("stays off the network in a test run with no fetcher injected", async () => {
    const real = vi.spyOn(globalThis, "fetch");
    expect(await getEurRate("USD", "2026-07-10")).toBeNull();
    expect(real).not.toHaveBeenCalled();
    real.mockRestore();
  });
});

describe("euroConversion", () => {
  it("prices a foreign total at the ECB rate", async () => {
    setFxFetcherForTests(fakeEcb().fetcher);
    expect(await euroConversion({ currency: "USD", originalAmount: 50.1, date: "2026-07-12" })).toEqual({
      totalAmount: 45.71, // 50.10 * 0.9123 = 45.7062
      fxRate: 0.9123,
      fxRateDate: "2026-07-10",
      fxSource: "ECB",
    });
  });

  it("lets a rate printed on the document win over the ECB's", async () => {
    const { fetcher, calls } = fakeEcb();
    setFxFetcherForTests(fetcher);
    const result = await euroConversion({ currency: "USD", originalAmount: 100, date: "2026-07-10", printedRate: 0.9 });
    expect(result).toEqual({ totalAmount: 90, fxRate: 0.9, fxRateDate: "2026-07-10", fxSource: "document" });
    expect(calls).toHaveLength(0);
  });

  it("is null for euros, an unusable amount, or a failed lookup", async () => {
    setFxFetcherForTests(async () => {
      throw new Error("offline");
    });
    expect(await euroConversion({ currency: "EUR", originalAmount: 10, date: null })).toBeNull();
    expect(await euroConversion({ currency: "USD", originalAmount: null, date: null })).toBeNull();
    expect(await euroConversion({ currency: "USD", originalAmount: 10, date: "2026-07-10" })).toBeNull();
  });

  it("rounds once to whole cents", () => {
    expect(convertToEuros(10, 0.33335)).toBe(3.33);
  });
});

describe("fxRateLine", () => {
  it("states the rate and the ECB day in Finnish", () => {
    expect(fxRateLine({ currency: "USD", fxRate: 0.9123, fxRateDate: "2026-07-12", fxSource: "ECB" })).toBe(
      "Kurssi 1 USD = 0,9123 EUR (EKP 12.7.2026)"
    );
    expect(fxRateLine({ currency: "USD", fxRate: 0.9, fxRateDate: null, fxSource: "document" })).toBe(
      "Kurssi 1 USD = 0,9000 EUR (laskulla)"
    );
  });

  it("says nothing for euros or when no rate was applied", () => {
    expect(fxRateLine({ currency: "EUR", fxRate: 1 })).toBeNull();
    expect(fxRateLine({ currency: "USD", fxRate: null })).toBeNull();
  });
});

describe("storedFxRate", () => {
  it("reads the recorded rate from an upload's reading, ready for fxRateLine", () => {
    const read = JSON.stringify({ currency: "USD", fxRate: 0.8749, fxRateDate: "2026-07-10", fxSource: "ECB" });
    const fx = storedFxRate(read);
    expect(fx).toEqual({ fxRate: 0.8749, fxRateDate: "2026-07-10", fxSource: "ECB" });
    expect(fxRateLine({ currency: "USD", ...fx })).toBe("Kurssi 1 USD = 0,8749 EUR (EKP 10.7.2026)");
  });

  it("returns nulls for no reading, an unreadable one, or no usable rate", () => {
    const none = { fxRate: null, fxRateDate: null, fxSource: null };
    expect(storedFxRate(null)).toEqual(none);
    expect(storedFxRate("{not json")).toEqual(none);
    expect(storedFxRate(JSON.stringify({ fxRate: null }))).toEqual(none);
    expect(storedFxRate(JSON.stringify({ fxRate: 0 }))).toEqual(none);
  });
});

describe("normalizeAIResult fxRate", () => {
  it("keeps a rate the document printed and drops nothing else", () => {
    const result = normalizeAIResult({ currency: "USD", originalAmount: 10, fxRate: 0.9123 }, "openai-compatible");
    expect(result.fxRate).toBe(0.9123);
    expect(result.originalAmount).toBe(10);
  });

  it("treats a missing, zero or absurd rate as not printed", () => {
    for (const fxRate of [null, undefined, 0, -1, "abc", 1e9]) {
      expect(normalizeAIResult({ currency: "USD", fxRate }, "openai-compatible").fxRate).toBeNull();
    }
  });
});

describe("unconvertedForeignTotal", () => {
  it("moves a dollar figure read as euros to the original amount, so it gets priced", () => {
    // OpenRouter "Amount paid $6.80" was booked as 6,80 € (2026-10-02).
    expect(unconvertedForeignTotal({ currency: "USD", totalAmount: 6.8, originalAmount: null, fxRate: null })).toEqual({
      currency: "USD",
      totalAmount: null,
      originalAmount: 6.8,
      fxRate: null,
    });
    // OpenCode $10.00 with the same number in both fields: a 1:1 "rate" nobody printed.
    expect(unconvertedForeignTotal({ currency: "USD", totalAmount: 10, originalAmount: 10 })).toMatchObject({
      totalAmount: null,
      originalAmount: 10,
    });
  });

  it("keeps a real euro figure, a printed rate, a euro document and an empty total", () => {
    const both = { currency: "USD", totalAmount: 9.06, originalAmount: 10 };
    expect(unconvertedForeignTotal(both)).toBe(both);
    const printed = { currency: "USD", totalAmount: 9, originalAmount: null, fxRate: 0.9 };
    expect(unconvertedForeignTotal(printed)).toBe(printed);
    const euros = { currency: "EUR", totalAmount: 12, originalAmount: null };
    expect(unconvertedForeignTotal(euros)).toBe(euros);
    const empty = { currency: "PLN", totalAmount: null, originalAmount: 5707.79 };
    expect(unconvertedForeignTotal(empty)).toBe(empty);
  });

  it("then prices it at the ECB rate like any foreign total", async () => {
    setFxFetcherForTests(fakeEcb().fetcher);
    const reading = unconvertedForeignTotal({ currency: "USD", totalAmount: 10, originalAmount: null, fxRate: null });
    expect(await euroConversion({ currency: reading.currency, originalAmount: reading.originalAmount, date: "2026-07-10" })).toMatchObject({
      totalAmount: 9.12,
      fxSource: "ECB",
    });
  });
});
