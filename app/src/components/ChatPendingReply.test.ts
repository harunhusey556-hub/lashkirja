import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { awaitingFirstWord, ChatPendingBubble, ChatPendingReply, PENDING_REPLY_DELAY_MS } from "./ChatPendingReply";

describe("F60: the thread shows the assistant is answering", () => {
  it("shows from send until the first word paints, and not otherwise", () => {
    expect(awaitingFirstWord(true, { role: "user" })).toBe(true);
    // The first word arrived: the answer bubble itself is the progress.
    expect(awaitingFirstWord(true, { role: "assistant" })).toBe(false);
    // Nothing is being sent.
    expect(awaitingFirstWord(false, { role: "user" })).toBe(false);
    expect(awaitingFirstWord(true, undefined)).toBe(false);
  });

  it("is a spoken status with three dots and no developer text", () => {
    const out = renderToStaticMarkup(createElement(ChatPendingBubble));
    expect(out).toContain('role="status"');
    expect(out).toContain("Avustaja kirjoittaa…");
    expect(out.match(/aria-hidden="true"/g)).toHaveLength(3);
  });
});

describe("C-7: the typing indicator is not shown for an instant answer", () => {
  it("renders nothing at first and waits at least 400 ms before showing", () => {
    expect(renderToStaticMarkup(createElement(ChatPendingReply))).toBe("");
    expect(PENDING_REPLY_DELAY_MS).toBeGreaterThanOrEqual(400);
  });
});
