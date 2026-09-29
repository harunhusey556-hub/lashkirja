import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// vi.mock is hoisted above the imports, so the factory loads React itself.
vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      react.createElement("a", { href, ...rest }, children as never),
  };
});

import ReviewQueue from "./ReviewQueue";

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

const RECEIPTS = [
  { id: "1", vendor: "Kahvila Oy", date: "2026-09-01T00:00:00.000Z", totalAmount: 12.5, fileName: "kahvila.pdf" },
  { id: "2", vendor: null, date: null, totalAmount: null, fileName: "tuntematon.pdf" },
];

describe("ReviewQueue", () => {
  it("shows the batch title with its count, description and total", () => {
    const out = html(
      createElement(ReviewQueue, {
        title: "Tarkastettavat sähköpostikuitit",
        description: "Odottavat hyväksyntää.",
        receipts: RECEIPTS,
        rejectLabel: "Hylkää",
        onReview: () => {},
      })
    );
    expect(out).toContain("Tarkastettavat sähköpostikuitit (2)");
    expect(out).toContain("Odottavat hyväksyntää.");
    expect(out).toContain("12,50");
  });

  it("renders an approve-all button only when onApproveAll is given", () => {
    const withAll = html(
      createElement(ReviewQueue, {
        title: "Muut tarkastettavat kuitit",
        description: "d",
        receipts: RECEIPTS,
        rejectLabel: "Hylkää",
        onReview: () => {},
        onApproveAll: () => {},
      })
    );
    expect(withAll).toContain("Hyväksy kaikki 2 kpl");

    const withoutAll = html(
      createElement(ReviewQueue, {
        title: "Muut tarkastettavat kuitit",
        description: "d",
        receipts: RECEIPTS,
        rejectLabel: "Hylkää",
        onReview: () => {},
      })
    );
    expect(withoutAll).not.toContain("Hyväksy kaikki");
  });

  // IA-23: the rows stay mounted inside an animated Disclosure, but while
  // collapsed that region is inert (not focusable, not read by VoiceOver).
  it("starts collapsed, with the batch's rows and their per-row actions inside an inert region", () => {
    const out = html(
      createElement(ReviewQueue, {
        title: "t",
        description: "d",
        receipts: RECEIPTS,
        rejectLabel: "Hylkää",
        onReview: () => {},
      })
    );
    expect(out).toContain('aria-expanded="false"');
    const inertStart = out.indexOf('data-open="false" inert=""');
    expect(inertStart).toBeGreaterThan(-1);
    expect(out.indexOf("Kahvila Oy")).toBeGreaterThan(inertStart);
  });
});
