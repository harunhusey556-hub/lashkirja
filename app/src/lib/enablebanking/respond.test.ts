import { describe, expect, it } from "vitest";
import { EnableBankingError } from "./client";
import { respondToBankError } from "./respond";

describe("V33: a definite bank failure is not answered like a dead gateway", () => {
  it("answers an unreadable bank reply with its own sentence and a status the app does not read as a gateway timeout", async () => {
    const response = respondToBankError(new EnableBankingError("Pankin vastausta ei voitu lukea.", 502, "INVALID_RESPONSE"));
    // 502/503/504 make the client say "Palvelin ei vastannut hetkeen. Tarkista onnistuiko toiminto".
    expect([502, 503, 504]).not.toContain(response.status);
    expect((await response.json()).error).toBe("Pankin vastausta ei voitu lukea. Yritä uudelleen.");
  });

  it("keeps the other statuses as they were", () => {
    expect(respondToBankError(new EnableBankingError("x", 429, "ASPSP_RATE_LIMIT_EXCEEDED")).status).toBe(429);
    expect(respondToBankError(new EnableBankingError("x", 404, "NOT_FOUND")).status).toBe(404);
  });
});
