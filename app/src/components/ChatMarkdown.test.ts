import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown, parseBlocks } from "./ChatMarkdown";

describe("parseBlocks", () => {
  it("splits paragraphs, bullets, and numbered lines", () => {
    expect(parseBlocks("Hei\n\n- yksi\n- kaksi\n\n1. a\n2) b")).toEqual([
      { type: "p", text: "Hei" },
      {
        type: "ul",
        items: [
          { text: "yksi", depth: 0 },
          { text: "kaksi", depth: 0 },
        ],
      },
      {
        type: "ol",
        items: [
          { text: "a", depth: 0 },
          { text: "b", depth: 0 },
        ],
      },
    ]);
  });

  it("keeps bold, italic, and code markers for the inline renderer", () => {
    expect(parseBlocks("ALV **24%** ja *kursiivi* sekä `koodi`")).toEqual([
      { type: "p", text: "ALV **24%** ja *kursiivi* sekä `koodi`" },
    ]);
  });

  it("reads headings, fenced code, and a nested bullet", () => {
    expect(parseBlocks("# Otsikko\n\n```\nconst a = 1\n```\n\n- yksi\n  - sisä\n    - syvempi")).toEqual([
      { type: "h", level: 1, text: "Otsikko" },
      { type: "pre", text: "const a = 1" },
      {
        type: "ul",
        items: [
          { text: "yksi", depth: 0 },
          { text: "sisä", depth: 1 },
          { text: "syvempi", depth: 2 },
        ],
      },
    ]);
  });

  it("parses a table and keeps a half-streamed pipe row as text", () => {
    expect(parseBlocks("| A | B |\n| --- | --- |\n| 1 | 2 |")).toEqual([
      { type: "table", headers: ["A", "B"], rows: [["1", "2"]] },
    ]);
    expect(parseBlocks("| kesken | rivi |")).toEqual([{ type: "p", text: "| kesken | rivi |" }]);
  });

  it("keeps an unclosed marker and an open fence without throwing", () => {
    expect(parseBlocks("**puoli")).toEqual([{ type: "p", text: "**puoli" }]);
    expect(parseBlocks("```\nconst pitkä = true")).toEqual([{ type: "pre", text: "const pitkä = true" }]);
  });

  it("wraps long urls and code so they stay inside the bubble", () => {
    const url = `https://example.com/${"a".repeat(180)}`;
    const html = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        text: `Katso ${url}\n\n\`\`\`\n${"token".repeat(40)}\n\`\`\`\n\n| Sarake | Arvo |\n| --- | --- |\n| yksi | kaksi |`,
      })
    );
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).toContain("<table");
    expect(html).not.toContain("<script");
  });
});
