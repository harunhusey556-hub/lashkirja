import { describe, expect, it } from "vitest";
import {
  CHAT_CONTEXT_LIMIT,
  CHAT_MESSAGE_MAX,
  boundContext,
  copilotRequestMessages,
  historyCursorWhere,
  messageTooLong,
  ownerIsFresh,
  settleChatStream,
  streamEndReason,
  titleFromMessage,
} from "./chat-turn";

describe("chat turn rules", () => {
  it("rejects a message over the length cap", () => {
    expect(messageTooLong("a".repeat(CHAT_MESSAGE_MAX))).toBe(false);
    expect(messageTooLong("a".repeat(CHAT_MESSAGE_MAX + 1))).toBe(true);
  });

  it("pages by createdAt and id so equal timestamps are not skipped", () => {
    const createdAt = new Date("2026-09-01T12:00:00.000Z");
    expect(historyCursorWhere(createdAt, "m-2")).toEqual({
      OR: [
        { createdAt: { lt: createdAt } },
        { AND: [{ createdAt }, { id: { lt: "m-2" } }] },
      ],
    });
  });

  it("sends a bounded window that still ends with the latest question", () => {
    const prior = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn-${index}`,
    }));
    const messages = copilotRequestMessages("system", "uusin kysymys", prior);
    expect(messages[0]).toEqual({ role: "system", content: "system" });
    expect(messages).toHaveLength(1 + CHAT_CONTEXT_LIMIT);
    expect(messages.at(-1)).toEqual({ role: "user", content: "uusin kysymys" });
    expect(boundContext(prior)).toHaveLength(CHAT_CONTEXT_LIMIT);
  });

  it("names a short conversation from the first question", () => {
    expect(titleFromMessage("  Mikä   on ALV?  ")).toBe("Mikä on ALV?");
    expect(titleFromMessage("a".repeat(80)).endsWith("…")).toBe(true);
  });

  it("treats a fresh streaming owner as busy and a stale one as free", () => {
    const now = new Date("2026-09-27T08:00:00.000Z");
    expect(ownerIsFresh(new Date("2026-09-27T07:59:40.000Z"), now)).toBe(true);
    expect(ownerIsFresh(new Date("2026-09-27T07:58:00.000Z"), now)).toBe(false);
    expect(ownerIsFresh(null, now)).toBe(false);
  });

  it("ends stop, disconnect, timeout, and backgrounding with an explicit status", () => {
    expect(settleChatStream({ reason: "stop", collected: "" }).status).toBe("cancelled");
    expect(settleChatStream({ reason: "disconnect", collected: "puoli" }).status).toBe("incomplete");
    expect(settleChatStream({ reason: "background", collected: "" }).status).toBe("cancelled");
    expect(settleChatStream({ reason: "timeout", collected: "" }).status).toBe("failed");
    expect(settleChatStream({ reason: "timeout", collected: "osa" }).status).toBe("incomplete");
    expect(settleChatStream({ reason: "provider_error", collected: "" }).status).toBe("failed");
    expect(settleChatStream({ reason: "complete", collected: "valmis" }).status).toBe("complete");
    expect(settleChatStream({ reason: "complete", collected: "   " }).status).toBe("failed");
  });

  it("reads the abort reason for disconnect and backgrounding", () => {
    const disconnect = new AbortController();
    disconnect.abort("disconnect");
    const background = new AbortController();
    background.abort("background");
    const stop = new AbortController();
    stop.abort();
    expect(streamEndReason({ signal: disconnect.signal, timedOut: false, threw: false })).toBe("disconnect");
    expect(streamEndReason({ signal: background.signal, timedOut: false, threw: false })).toBe("background");
    expect(streamEndReason({ signal: stop.signal, timedOut: false, threw: false })).toBe("stop");
    expect(streamEndReason({ signal: new AbortController().signal, timedOut: true, threw: false })).toBe("timeout");
  });
});
