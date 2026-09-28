import { describe, expect, it } from "vitest";
import {
  appReturnUrl,
  bankCallbackPath,
  classifyBankReturn,
  isAppBankState,
  pendingBankAuthPayload,
  readPendingBankAuth,
} from "./bank-return";

describe("classifyBankReturn", () => {
  it("treats a code and state as success", () => {
    expect(classifyBankReturn({ code: "abc", state: "xyz" }).kind).toBe("success");
  });

  it("names a cancel, an expired session, and a missing callback", () => {
    expect(classifyBankReturn({ error: "access_denied" })).toMatchObject({
      kind: "cancelled",
      message: "Yhdistäminen peruutettiin pankissa.",
    });
    expect(classifyBankReturn({ error: "session_expired" }).kind).toBe("expired");
    expect(classifyBankReturn({ error: "consent_expired" }).message).toContain("vanheni");
    expect(classifyBankReturn({ code: "", state: "" }).kind).toBe("missing");
    expect(classifyBankReturn({ error: "server_error" }).kind).toBe("failed");
  });
});

describe("pending bank auth", () => {
  it("reads a fresh marker and drops an expired one", () => {
    const now = 1_700_000_000_000;
    const raw = pendingBankAuthPayload(now);
    expect(readPendingBankAuth(raw, now + 1000)?.startedAt).toBe(now);
    expect(readPendingBankAuth(raw, now + 3 * 60 * 60 * 1000)).toBeNull();
    expect(readPendingBankAuth("nope", now)).toBeNull();
  });
});

describe("bankCallbackPath", () => {
  it("keeps only our callback path and query", () => {
    expect(bankCallbackPath("https://app.example/bank/callback?code=1&state=2")).toBe(
      "/bank/callback?code=1&state=2"
    );
    expect(bankCallbackPath("https://app.example/asetukset")).toBeNull();
    expect(bankCallbackPath("not a url")).toBeNull();
    expect(bankCallbackPath("lashkirja://bank/callback?code=1&state=2")).toBe(
      "/bank/callback?code=1&state=2"
    );
    expect(bankCallbackPath("lashkirja:///bank/callback?code=9")).toBe("/bank/callback?code=9");
    expect(bankCallbackPath("lashkirja://asetukset")).toBeNull();
  });
});

describe("isAppBankState", () => {
  it("recognises only a state carrying the app prefix", () => {
    expect(isAppBankState("app1.abcdef")).toBe(true);
    expect(isAppBankState("abcdef")).toBe(false);
    expect(isAppBankState(null)).toBe(false);
    expect(isAppBankState(undefined)).toBe(false);
    expect(isAppBankState("")).toBe(false);
  });
});

describe("appReturnUrl", () => {
  it("turns the web callback query into the app scheme URL, encoding preserved", () => {
    expect(appReturnUrl("?code=abc&state=app1.def")).toBe(
      "lashkirja://bank/callback?code=abc&state=app1.def"
    );
    // A query string without the leading "?" still gets one.
    expect(appReturnUrl("code=abc&state=app1.def")).toBe(
      "lashkirja://bank/callback?code=abc&state=app1.def"
    );
    // Percent-encoding in the source query is passed through untouched.
    expect(appReturnUrl("?code=a%2Bb&state=app1.%20x")).toBe(
      "lashkirja://bank/callback?code=a%2Bb&state=app1.%20x"
    );
    expect(appReturnUrl("")).toBe("lashkirja://bank/callback");
  });
});
