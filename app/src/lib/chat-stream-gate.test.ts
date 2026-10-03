import { describe, expect, it } from "vitest";
import { GuardedReplyStream, sentenceNeedsGuard } from "./chat-stream-gate";
import { enforceAssistantReply, EMPTY_HONESTY, HONESTY_REFUSAL, type HonestyContext } from "./chat-honesty";

/** A fake model stream: the pieces a provider would send, one by one. */
async function* fakeStream(pieces: string[]): AsyncGenerator<string> {
  for (const piece of pieces) {
    await Promise.resolve();
    yield piece;
  }
}

/** What the client sees: every {delta} the route sends while streaming, then the final remainder. */
async function run(pieces: string[], ctx: HonestyContext) {
  const gate = new GuardedReplyStream();
  const visibleWhileStreaming: string[] = [];
  let collected = "";
  for await (const piece of fakeStream(pieces)) {
    collected += piece;
    const out = gate.push(piece);
    if (out) visibleWhileStreaming.push(out);
  }
  const guarded = enforceAssistantReply(collected, ctx);
  const rest = gate.finish({ content: guarded.text, status: guarded.rejected ? "incomplete" : "complete" });
  return { visibleWhileStreaming: visibleWhileStreaming.join(""), rest, final: guarded.text, rejected: guarded.rejected };
}

describe("A3: streaming shows no figure before the guard passes", () => {
  it("releases plain sentences at once and holds the one with an amount", async () => {
    const ctx = { ...EMPTY_HONESTY, allowedAmounts: ["287.01"] };
    const result = await run(["Hei! Katsoin kirjan", "pitoasi. Syyskuun ALV on 28", "7,01 €. Kerro, jos", " tarvitset muuta."], ctx);
    expect(result.visibleWhileStreaming).toBe("Hei! Katsoin kirjanpitoasi. ");
    expect(result.visibleWhileStreaming).not.toMatch(/287/);
    expect(result.rejected).toBe(false);
    expect(result.visibleWhileStreaming + result.rest).toBe(result.final);
  });

  it("never shows a wrong figure: the correction replaces the held sentence", async () => {
    const result = await run(["Tarkistin luvut. ", "ALV on 999", " EUR.", " Muuta?"], EMPTY_HONESTY);
    expect(result.rejected).toBe(true);
    expect(result.visibleWhileStreaming).toBe("Tarkistin luvut. ");
    expect(result.rest).toBe("");
    expect(result.final).toBe(HONESTY_REFUSAL);
  });

  it("holds a false action claim, a percentage and a number split over a line", async () => {
    expect((await run(["Selvä. ", "Lähetin laskun.", " Kiitos."], EMPTY_HONESTY)).visibleWhileStreaming).toBe("Selvä. ");
    expect((await run(["Kanta on 25,5", " %. Muuta?"], EMPTY_HONESTY)).visibleWhileStreaming).toBe("");
    expect((await run(["Summa on 999\n", "EUR."], EMPTY_HONESTY)).visibleWhileStreaming).toBe("");
  });

  it("waits for the next character before calling a dot a sentence end", () => {
    const gate = new GuardedReplyStream();
    expect(gate.push("Hinta 12.")).toBe("");
    expect(gate.push("50 €. Hei")).toBe("");
    const plain = new GuardedReplyStream();
    expect(plain.push("Hei.")).toBe("");
    expect(plain.push(" Moi")).toBe("Hei. ");
  });

  it("stops at code, like before", () => {
    const gate = new GuardedReplyStream();
    expect(gate.push("Tässä:\n```js\n")).toBe("Tässä:\n");
    expect(gate.push("const a = 1;\n```\n")).toBe("");
  });

  it("knows which sentences need the guard", () => {
    for (const text of ["ALV 12,50 €.", "€999", "25 %", "I sent it.", "Katso [Kuitit](/kuitit).", "id aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]) {
      expect(sentenceNeedsGuard(text), text).toBe(true);
    }
    for (const text of ["Hei! ", "Sinulla on 3 kuittia odottamassa. ", "Voit lähettää laskun Laskut-näkymästä. "]) {
      expect(sentenceNeedsGuard(text), text).toBe(false);
    }
  });
});
