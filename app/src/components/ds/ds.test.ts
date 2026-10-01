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

import { ActionPill, DetailHero, FilterChips, KeyValueList, ListRow, MoreMenu, PageTitle, Section, StatusTag, SummaryCard } from "./index";

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe("design system components", () => {
  it("PageTitle renders one h1 with the title", () => {
    const out = html(createElement(PageTitle, { title: "Myynti", subtitle: "Laskut" }));
    expect(out.match(/<h1/g)?.length).toBe(1);
    expect(out).toContain(">Myynti</h1>");
  });

  it("ActionPill keeps its 36px visual height but its hit area is stretched to at least 44px", () => {
    // eslint-disable-next-line react/no-children-prop -- non-JSX createElement call; ActionPill's `children` is a required prop, so createElement's typing needs it in the props object rather than as a rest arg.
    const out = html(createElement(ActionPill, { href: "/x", children: "Toiminto" }));
    expect(out).toContain("min-h-9");
    expect(out).toContain("before:absolute");
    expect(out).toContain("before:inset-x-0");
    expect(out).toContain("before:-inset-y-1");
  });

  it("ListRow with href composes a full accessible name and keeps the trailing action out of the hidden block", () => {
    const out = html(createElement(ListRow, {
      title: "Anna Asiakas",
      amount: "602,40 €",
      secondary: "Lasku 2",
      href: "/laskut/2",
      // eslint-disable-next-line react/no-children-prop -- see ActionPill test above.
      trailing: createElement(ActionPill, { href: "/laskut/2?toiminto=muistutus", children: "Muistuta" }),
    }));
    expect(out).toContain('aria-label="Anna Asiakas, 602,40 €, Lasku 2"');
    const firstLinkEnd = out.indexOf("</a>");
    expect(out.indexOf("Muistuta")).toBeGreaterThan(firstLinkEnd);
    expect(out).toContain("row-link");

    // The trailing action pill must stay outside any aria-hidden ancestor: the last aria-hidden="true"
    // block in the row (the visible text) closes before "Muistuta" appears.
    const lastHiddenAttr = out.lastIndexOf('aria-hidden="true"');
    const hiddenBlockCloses = out.indexOf("</span>", lastHiddenAttr);
    expect(out.indexOf("Muistuta")).toBeGreaterThan(hiddenBlockCloses);

    // Regression: the trailing wrapper must be pointer-events-none (a non-interactive trailing
    // element, e.g. a bare StatusTag, must let clicks fall through to the row's own overlay link
    // below it instead of swallowing them), while ActionPill opts back in with pointer-events-auto
    // so it stays clickable itself.
    expect(out).toContain("pointer-events-none relative z-10 ml-auto shrink-0");
    expect(out).not.toContain("pointer-events-auto relative z-10 shrink-0");
    expect(out).toContain("pointer-events-auto");
    const pillOpen = out.indexOf("Muistuta") >= 0 ? out.lastIndexOf("<a", out.indexOf("Muistuta")) : -1;
    expect(out.slice(pillOpen, out.indexOf("Muistuta"))).toContain("pointer-events-auto");
  });

  it("ActionPill's button variant can be disabled (e.g. while a request is in flight)", () => {
    // eslint-disable-next-line react/no-children-prop -- see ActionPill test above.
    const out = html(createElement(ActionPill, { onClick: () => {}, disabled: true, children: "Linkitä" }));
    expect(out).toContain("disabled");
    expect(out).not.toContain("<a");
  });

  it("MoreMenu's trigger opts back into pointer events (it sits inside a pointer-events-none trailing slot)", () => {
    const out = html(createElement(MoreMenu, { items: [{ label: "Avaa PDF", onSelect: () => {} }] }));
    const triggerEnd = out.indexOf("</button>");
    expect(out.slice(0, triggerEnd)).toContain("pointer-events-auto");
  });

  it("ListRow without href or onClick is not interactive and is never aria-hidden", () => {
    const out = html(createElement(ListRow, { title: "Elisa Oyj", amount: "−29,90 €" }));
    expect(out).not.toContain("<a");
    expect(out).not.toContain("<button");
    expect(out).not.toContain('aria-hidden="true"');
  });

  it("StatusTag shows its words", () => {
    // eslint-disable-next-line react/no-children-prop -- see ActionPill test above.
    expect(html(createElement(StatusTag, { tone: "danger", children: "Myöhässä" }))).toContain("Myöhässä");
  });

  it("FilterChips marks exactly the selected chip pressed and shows counts", () => {
    const out = html(createElement(FilterChips, {
      label: "Suodata laskut",
      items: [{ id: "all", label: "Kaikki", count: 4 }, { id: "overdue", label: "Myöhässä", count: 1 }],
      value: "overdue",
      onChange: () => {},
    }));
    expect(out.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(out).toContain('aria-label="Suodata laskut"');
    expect(out).toContain("overflow-x-auto");
    expect(out).toMatch(/Myöhässä.*1/);
  });

  it("Section shows its title and wraps rows in one card", () => {
    // eslint-disable-next-line react/no-children-prop -- see ActionPill test above.
    const out = html(createElement(Section, { title: "Myöhässä", count: 1, children: createElement("div", null, "rivi") }));
    expect(out).toContain(">Myöhässä</h2>");
    expect(out).toContain("rounded-card");
  });

  it("SummaryCard, DetailHero and KeyValueList render their content", () => {
    expect(html(createElement(SummaryCard, { label: "Avoinna", value: "683,98 €", note: "602,40 € myöhässä" }))).toContain("683,98 €");
    const hero = html(createElement(DetailHero, { amount: "602,40 €", title: "Anna Asiakas", meta: "Lasku 2" }));
    expect(hero).toContain(">Anna Asiakas</h1>");
    const kv = html(createElement(KeyValueList, { rows: [{ label: "Eräpäivä", value: "12.9.2026" }] }));
    expect(kv).toContain("<dt");
    expect(kv).toContain("12.9.2026");
  });

  it("MoreMenu renders a labelled trigger while closed", () => {
    const out = html(createElement(MoreMenu, { items: [{ label: "Avaa PDF", onSelect: () => {} }] }));
    expect(out).toContain('aria-label="Lisää toimintoja"');
    expect(out).toContain('aria-haspopup="dialog"');
  });

  // AX-13, R4: one label, one role, one effect.
  it("a navigating ActionPill is a link named 'Avaa: ...' that still contains its visible word", () => {
    // eslint-disable-next-line react/no-children-prop -- see ActionPill test above.
    const out = html(createElement(ActionPill, { href: "/laskut/lasku?id=1", ariaLabel: "Muistuta: Kauneus Oy", children: "Muistuta" }));
    expect(out).toContain('aria-label="Avaa: Muistuta: Kauneus Oy"');
    // eslint-disable-next-line react/no-children-prop -- see ActionPill test above.
    const already = html(createElement(ActionPill, { href: "/x", ariaLabel: "Avaa: Ostolasku", children: "Avaa" }));
    expect(already).toContain('aria-label="Avaa: Ostolasku"');
    // An in-place pill stays a button with its own name.
    // eslint-disable-next-line react/no-children-prop -- see ActionPill test above.
    const button = html(createElement(ActionPill, { onClick: () => {}, ariaLabel: "Muistuta: Kauneus Oy", children: "Muistuta" }));
    expect(button).toContain("<button");
    expect(button).toContain('aria-label="Muistuta: Kauneus Oy"');
  });

  it("a row never carries a second link to its own href: the pill is drawn but is not a control", () => {
    const out = html(createElement(ListRow, {
      title: "Anna Asiakas",
      amount: "602,40 €",
      href: "/laskut/lasku?id=2",
      // eslint-disable-next-line react/no-children-prop -- see ActionPill test above.
      trailing: createElement(ActionPill, { href: "/laskut/lasku?id=2", ariaLabel: "Muistuta: Anna Asiakas", children: "Muistuta" }),
    }));
    expect(out.match(/<a /g)?.length).toBe(1);
    expect(out).toContain("Muistuta");
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain("Avaa: Muistuta");
  });

  it("a row can show its secondary text in full, with the action on its own line below (F29)", () => {
    const text = "Kuittia ei voitu lukea. Kokeile terävämpää kuvaa tai tekstipohjaista PDF:ää.";
    const clamped = html(createElement(ListRow, { title: "Kuitti 28.9.", secondary: text }));
    expect(clamped).toContain("clamp-lines text-caption");
    const full = html(createElement(ListRow, { title: "Kuitti 28.9.", secondary: text, secondaryLines: "all" }));
    expect(full).toContain(text);
    expect(full).not.toContain("clamp-lines text-caption");
    expect(full).toContain("basis-full");
  });

  it("KeyValueList never shrinks inside a flex column, so a scrolling sheet scrolls to its last row (F42)", () => {
    const kv = html(createElement(KeyValueList, { rows: [{ label: "Luotu", value: "3 laskua" }] }));
    // overflow-hidden gives the list a minimum height of 0: without shrink-0 a
    // flex-col scroller squeezes it and clips the rows instead of scrolling.
    expect(kv).toMatch(/<dl class="[^"]*shrink-0/);
  });

  it("KeyValueList can offer Kopioi for an identifier, named for what it copies", () => {
    const kv = html(createElement(KeyValueList, {
      rows: [{ label: "Viite", value: "1 2345", copy: { text: "1 2345", what: "Viitenumero" } }],
    }));
    expect(kv).toContain(">Kopioi</button>");
    expect(kv).toContain('aria-label="Kopioi Viitenumero"');
  });
});
