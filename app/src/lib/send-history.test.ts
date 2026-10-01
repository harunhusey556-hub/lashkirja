import { describe, expect, it } from "vitest";
import { CRASHED_SEND_NOTE, sendAttemptView } from "./send-history";

describe("sendAttemptView", () => {
  it("V41: an attempt closed after a crash is interrupted, not refused by the recipient", () => {
    const view = sendAttemptView({ status: "failed", error: CRASHED_SEND_NOTE });
    expect(view.title).toBe("Lähetys keskeytyi");
    expect(view.reason).toMatch(/käynnistyi uudelleen/);
    expect(view.reason).toMatch(/voinut mennä perille/);
    expect(view.reason).not.toMatch(/ei ottanut viestiä vastaan/);
  });

  it("keeps the refusal text for a genuine failure and never shows the raw error", () => {
    const view = sendAttemptView({ status: "failed", error: "535 5.7.8 Authentication failed" });
    expect(view.title).toBe("Lähetys epäonnistui");
    expect(view.reason).toBe("vastaanottajan palvelin ei ottanut viestiä vastaan");
  });

  it("does not call an accepted but unrecorded send 'in progress'", () => {
    expect(sendAttemptView({ status: "ambiguous", error: null }).title).toBe("Lähetys jäi epäselväksi");
  });

  it("names sent and in-flight attempts without a reason", () => {
    expect(sendAttemptView({ status: "sent", error: null })).toMatchObject({
      title: "Lähetetty sähköpostilla",
      reason: null,
    });
    expect(sendAttemptView({ status: "sending", error: null })).toMatchObject({
      title: "Lähetys kesken",
      reason: null,
    });
  });
});
