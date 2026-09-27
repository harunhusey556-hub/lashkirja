import { describe, expect, it } from "vitest";
import {
  bankCallbackPath,
  classifyBankReturn,
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
  });
});
