import { describe, expect, it } from "vitest";
import {
  autoAcceptBlock,
  autoAcceptSummary,
  canAutoAccept,
  createLimiter,
  takesAutoSavePath,
  uploadOutcomeCounts,
  type AutoAcceptInput,
} from "./auto-accept";

const complete: AutoAcceptInput = {
  vendor: "K-Market Kamppi",
  date: "2026-09-14",
  totalAmountCents: 1250,
  confidence: 0.85,
  source: "ai",
  documentType: "receipt",
  duplicate: false,
};

describe("auto-accept rule", () => {
  it("accepts a complete, confident reading", () => {
    expect(autoAcceptBlock(complete)).toBeNull();
    expect(canAutoAccept(complete)).toBe(true);
  });

  it("takes the euro amount from either field", () => {
    expect(canAutoAccept({ ...complete, totalAmountCents: undefined, totalAmount: 12.5 })).toBe(true);
  });

  it("leaves a missing vendor for review", () => {
    expect(autoAcceptBlock({ ...complete, vendor: null })).toBe("vendor");
    expect(autoAcceptBlock({ ...complete, vendor: "   " })).toBe("vendor");
  });

  it("leaves a missing amount for review", () => {
    expect(autoAcceptBlock({ ...complete, totalAmountCents: null })).toBe("amount");
    expect(autoAcceptBlock({ ...complete, totalAmountCents: undefined, totalAmount: null })).toBe("amount");
  });

  it("leaves a zero or negative amount for review", () => {
    expect(autoAcceptBlock({ ...complete, totalAmountCents: 0 })).toBe("amount");
    expect(autoAcceptBlock({ ...complete, totalAmountCents: -500 })).toBe("amount");
    expect(autoAcceptBlock({ ...complete, totalAmountCents: undefined, totalAmount: 0 })).toBe("amount");
  });

  it("leaves a missing date for review", () => {
    expect(autoAcceptBlock({ ...complete, date: null })).toBe("date");
    expect(autoAcceptBlock({ ...complete, date: "" })).toBe("date");
  });

  it("leaves a likely duplicate for review", () => {
    expect(autoAcceptBlock({ ...complete, duplicate: true })).toBe("duplicate");
  });

  it("leaves a low-confidence or unscored reading for review", () => {
    expect(autoAcceptBlock({ ...complete, confidence: 0.4 })).toBe("low_confidence");
    expect(autoAcceptBlock({ ...complete, confidence: null })).toBe("low_confidence");
    expect(autoAcceptBlock({ ...complete, confidence: Number.NaN })).toBe("low_confidence");
  });

  it("leaves an unsure field for review even when the overall score is high", () => {
    expect(autoAcceptBlock({ ...complete, fieldConfidence: { totalAmount: 0.3 } })).toBe("low_confidence");
    expect(autoAcceptBlock({ ...complete, fieldConfidence: { vendor: 0.9, date: 0.9 } })).toBeNull();
  });

  it("never accepts a file nothing could be read from", () => {
    expect(autoAcceptBlock({ ...complete, source: "manual" })).toBe("unreadable");
    expect(autoAcceptBlock({ ...complete, unreadable: true })).toBe("unreadable");
  });

  it("never accepts a reading that is not a receipt or a bill", () => {
    expect(autoAcceptBlock({ ...complete, documentType: "marketing" })).toBe("not_a_receipt");
    expect(autoAcceptBlock({ ...complete, documentType: "other" })).toBe("not_a_receipt");
    expect(autoAcceptBlock({ ...complete, documentType: "invoice" })).toBeNull();
    expect(autoAcceptBlock({ ...complete, documentType: null })).toBeNull();
  });
});

describe("which path a finished upload takes", () => {
  const gapped = { ...complete, vendor: null };
  it("a pick of several files saves every reading, complete or not", () => {
    expect(takesAutoSavePath({ enabled: true, several: true, reading: complete })).toBe(true);
    expect(takesAutoSavePath({ enabled: true, several: true, reading: gapped })).toBe(true);
  });

  it("a single file is saved only when complete; otherwise the form opens", () => {
    expect(takesAutoSavePath({ enabled: true, several: false, reading: complete })).toBe(true);
    expect(takesAutoSavePath({ enabled: true, several: false, reading: gapped })).toBe(false);
  });

  it("never when the screen has it off (editing, a pick for one bank row)", () => {
    expect(takesAutoSavePath({ enabled: false, several: true, reading: complete })).toBe(false);
    expect(takesAutoSavePath({ enabled: false, several: false, reading: complete })).toBe(false);
  });
});

describe("upload outcome summary", () => {
  it("names the three buckets the owner asked for", () => {
    expect(autoAcceptSummary({ approved: 87, pending: 11, failed: 2, background: 0 })).toBe(
      "Hyväksyttiin automaattisesti 87 · 11 odottaa tarkistusta · 2 epäonnistui"
    );
  });

  it("leaves out empty buckets and names files still being read", () => {
    expect(autoAcceptSummary({ approved: 5, pending: 0, failed: 0, background: 0 })).toBe(
      "Hyväksyttiin automaattisesti 5"
    );
    expect(autoAcceptSummary({ approved: 0, pending: 3, failed: 0, background: 1 })).toBe(
      "3 odottaa tarkistusta · 1 käsitellään taustalla"
    );
    expect(autoAcceptSummary({ approved: 0, pending: 0, failed: 0, background: 0 })).toBe(
      "Yhtään kuittia ei tallennettu."
    );
  });

  it("counts queue rows by their outcome, a failure stays a failure", () => {
    expect(
      uploadOutcomeCounts([
        { status: "saved", outcome: "approved" },
        { status: "saved", outcome: "approved" },
        { status: "saved", outcome: "pending" },
        { status: "failed" },
        { status: "background" },
        { status: "cancelled" },
      ])
    ).toEqual({ approved: 2, pending: 1, failed: 1, background: 1 });
  });
});

describe("createLimiter", () => {
  it("never runs more than the limit at once and finishes everything", async () => {
    const limit = createLimiter(4);
    let inFlight = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        limit(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1 + (index % 3)));
          inFlight -= 1;
          return index;
        })
      )
    );
    expect(peak).toBe(4);
    expect(results).toEqual(Array.from({ length: 30 }, (_, index) => index));
  });

  it("a failure does not stop the rest", async () => {
    const limit = createLimiter(2);
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        limit(async () => {
          if (index === 1) throw new Error("boom");
          return index;
        })
      )
    );
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(5);
    expect(settled[1].status).toBe("rejected");
  });
});
