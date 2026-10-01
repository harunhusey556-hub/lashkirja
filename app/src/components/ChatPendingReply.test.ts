import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { awaitingFirstWord, ChatPendingReply } from "./ChatPendingReply";

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
    const out = renderToStaticMarkup(createElement(ChatPendingReply));
    expect(out).toContain('role="status"');
    expect(out).toContain("Avustaja kirjoittaa…");
    expect(out.match(/aria-hidden="true"/g)).toHaveLength(3);
  });
});
