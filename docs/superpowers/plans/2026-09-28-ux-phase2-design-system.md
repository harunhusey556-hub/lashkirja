# UX Restructure, Phase 2 (Design System + New Look Everywhere) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every screen of LashKirja looks like the approved mockups: one set of tokens, one set of shared components, every page migrated to them, without losing any existing function.

**Architecture:** Tokens live in `app/src/app/globals.css` `@theme`. Shared components live in `app/src/components/ds/` (one file each, pure presentational, no data fetching). Status wording and colours live in `app/src/lib/status-labels.ts`. Pages keep their data logic and swap their markup to the components, one page family per task. The shell stops showing a header title only in the last task, after every page renders its own `PageTitle` or `DetailHero`.

**Tech Stack:** Next.js 16.2 App Router (read `app/node_modules/next/dist/docs/` before touching routing), React 19, TypeScript, Tailwind v4 (`@theme` tokens become utilities, e.g. `--color-ink` → `text-ink`, `--radius-card` → `rounded-card`), Vitest 4 (node environment, `src/**/*.test.ts` only: component tests use `react-dom/server` `renderToStaticMarkup` + `createElement`, no JSX in tests), Playwright 1.62 via the installed Chrome.

**Spec:** `docs/superpowers/specs/2026-09-27-ux-restructure-design.md` §3 (screens), §10 (visual language, tokens, components, shell, coverage table). Approved mockups: `docs/superpowers/specs/2026-09-27-ux-restructure/01-koti.png` … `07-lasku-detail.png`.

## Global Constraints

- Tokens (exact): `--color-canvas: #f6f3ef; --color-surface: #fffdfb; --color-line: #e7e1da; --color-ink: #26221f; --color-ink-2: #6a645f; --color-accent-soft: #f3e6e3; --radius-card: 14px;`. Existing `accent #9a5650`, `success`, `danger`, `warning` stay.
- Cards/groups: `rounded-card border border-line bg-surface`, no shadow; rows divided by `divide-y divide-line`. Never a card inside a card.
- Section headings: sentence case, 13px, `text-ink-2`. No uppercase/tracked eyebrow labels anywhere (remove existing ones in every file a task touches).
- Type scale: large title 32px/700/−0.02em; row title 15px/500; secondary 13px `ink-2`; detail amount 40px/700 tabular; summary amount 28px/700; chips 14px/500.
- Buttons: primary `bg-ink text-canvas`, secondary `bg-surface border border-line text-ink`, text actions `text-accent`; all `rounded-card`, min height 48px, `font-semibold`.
- Money only through `formatEur` / `formatEurSigned` (`src/lib/format.ts`). No em dash (`—`) in any new or touched UI copy.
- Accessibility and tests: every control keeps its current accessible role and name; status words (`Luonnos`, `Lähetetty`, `Myöhässä`, `Maksettu`, `Hyvitetty`, `Avoin`, `Täsmää`, …) stay exact-text; the landmark `nav[aria-label="Päävalikko"]` and its button names stay. Touch targets ≥ 44px.
- Interaction: pressable elements carry `active-press` (the `[data-pressed]` shim in `layout.tsx` paints the press); never add `hover:`-only feedback; horizontally scrolling rows keep the class `overflow-x-auto` (the edge-swipe-back gesture exempts it).
- **No function may disappear.** Before editing a page, the implementer lists every button, link, form and action on it (the "function inventory"); after editing, the report shows where each one lives now (visible, in `MoreMenu`, or in a sheet).
- Each task ends with screenshots at 390×844 (isMobile, hasTouch, deviceScaleFactor 2) and 1440×900 of every page it touched, taken with the installed Chrome (`require("C:/Users/Hhusey/lashkirja/app/node_modules/@playwright/test").chromium.launch({ channel: "chrome" })`) against the dev server `http://127.0.0.1:3200` (demo@lashkirja.fi / demo123), saved outside the repo in the session scratchpad. Never submit forms that save data during screenshots.
- Environment rules: run npm/npx from `app/`; do not stop/restart node processes; never create git worktrees or junctions; do not run `next build` or Playwright e2e in this checkout; edit files with file tools, not sed/heredoc.
- Baselines (not regressions): unit tests 5 Windows-only failures (backup-script 3, db-permissions 1, db-upgrade 1); lint 12 errors / 35 warnings in untouched files. Only new failures/errors count.
- Commit trailer (every commit):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Dt441ofXM5z9eZZdckoQC9
  ```

---

### Task 1: Tokens, status labels, shared components

**Files:**
- Modify: `app/src/app/globals.css` (`@theme` block; one new rule block)
- Create: `app/src/lib/status-labels.ts`, `app/src/lib/status-labels.test.ts`
- Create: `app/src/components/ds/{PageTitle,Section,Card,ListRow,ActionPill,StatusTag,FilterChips,SummaryCard,DetailHero,KeyValueList,Timeline,BottomActions,MoreMenu,index}.tsx` (`index.ts` for the barrel)
- Create: `app/src/components/ds/ds.test.ts`

**Interfaces (produced, used by every later task):**
```ts
export type Tone = "neutral" | "accent" | "danger" | "success" | "warning";
export const SALES_STATUS: Record<InvoiceDisplayStatus, { label: string; tone: Tone }>;
export const PURCHASE_STATUS: Record<"open" | "overdue" | "paid" | "cancelled", { label: string; tone: Tone }>;
PageTitle({ title: string; subtitle?: ReactNode; action?: ReactNode })
Section({ title?: string; count?: number; action?: ReactNode; children: ReactNode; className?: string })
Card({ children: ReactNode; className?: string })
ListRow({ title: string; amount?: ReactNode; amountTone?: "default" | "positive" | "negative"; secondary?: ReactNode; trailing?: ReactNode; leading?: ReactNode; href?: string; onClick?: () => void; ariaLabel?: string })
ActionPill({ children: ReactNode; href?: string; onClick?: () => void; ariaLabel?: string })
StatusTag({ tone: Tone; children: ReactNode; icon?: ReactNode })
FilterChips<T extends string>({ label: string; items: { id: T; label: string; count?: number }[]; value: T; onChange: (id: T) => void })
SummaryCard({ label: string; value: ReactNode; note?: ReactNode; noteTone?: "accent" | "muted" })
DetailHero({ amount?: ReactNode; amountTone?: "default" | "positive" | "negative"; title: string; meta?: ReactNode; status?: ReactNode; menu?: ReactNode })
KeyValueList({ rows: { label: string; value: ReactNode }[] })
Timeline({ items: { title: string; meta?: ReactNode; tone?: "accent" | "muted" }[] })
BottomActions({ children: ReactNode })
MoreMenu({ items: { label: string; onSelect: () => void; tone?: "danger"; disabled?: boolean }[]; label?: string })
```

- [ ] **Step 1: Tokens.** In `globals.css` add to `@theme` (keep existing tokens):
  ```css
  --color-canvas: #f6f3ef;
  --color-surface: #fffdfb;
  --color-line: #e7e1da;
  --color-ink: #26221f;
  --color-ink-2: #6a645f;
  --color-accent-soft: #f3e6e3;
  --radius-card: 14px;
  ```
  and after the press-state rules add:
  ```css
  /* ListRow's stretched link: the press paints the row, not the invisible overlay. */
  .row-link[data-pressed="true"] { background: rgb(38 34 31 / 0.05); }
  /* FilterChips use aria-pressed for state; the generic inset shadow is not their look. */
  .ds-chip[aria-pressed="true"] { box-shadow: none; }
  ```
  Read the existing `[aria-pressed="true"]` rule first and confirm `.ds-chip[aria-pressed="true"]` wins on specificity; adjust with `:where()`/order if not.

- [ ] **Step 2: Failing tests.** `app/src/lib/status-labels.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { PURCHASE_STATUS, SALES_STATUS } from "./status-labels";

  describe("status labels", () => {
    it("keeps the Finnish sales invoice words the app already shows", () => {
      expect(Object.fromEntries(Object.entries(SALES_STATUS).map(([k, v]) => [k, v.label]))).toEqual({
        draft: "Luonnos", sent: "Lähetetty", overdue: "Myöhässä", paid: "Maksettu", credited: "Hyvitetty",
      });
      expect(SALES_STATUS.overdue.tone).toBe("danger");
      expect(SALES_STATUS.paid.tone).toBe("success");
    });
    it("keeps the purchase invoice words", () => {
      expect(PURCHASE_STATUS.open.label).toBe("Avoin");
      expect(PURCHASE_STATUS.cancelled.label).toBe("Mitätöity");
      expect(PURCHASE_STATUS.overdue.tone).toBe("danger");
    });
  });
  ```
  `app/src/components/ds/ds.test.ts`:
  ```ts
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

    it("ListRow with href uses a named stretched link and never nests the action inside it", () => {
      const out = html(createElement(ListRow, {
        title: "Anna Asiakas",
        amount: "602,40 €",
        secondary: "Lasku 2",
        href: "/laskut/2",
        trailing: createElement(ActionPill, { href: "/laskut/2?toiminto=muistutus" }, "Muistuta"),
      }));
      expect(out).toContain('aria-label="Anna Asiakas"');
      const firstLinkEnd = out.indexOf("</a>");
      expect(out.indexOf("Muistuta")).toBeGreaterThan(firstLinkEnd);
      expect(out).toContain("row-link");
    });

    it("ListRow without href or onClick is not interactive", () => {
      const out = html(createElement(ListRow, { title: "Elisa Oyj", amount: "−29,90 €" }));
      expect(out).not.toContain("<a");
      expect(out).not.toContain("<button");
    });

    it("StatusTag shows its words", () => {
      expect(html(createElement(StatusTag, { tone: "danger" }, "Myöhässä"))).toContain("Myöhässä");
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
      const out = html(createElement(Section, { title: "Myöhässä", count: 1 }, createElement("div", null, "rivi")));
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
  });
  ```
  Run `npx vitest run src/lib/status-labels.test.ts src/components/ds/ds.test.ts` → FAIL (modules missing).

- [ ] **Step 3: `app/src/lib/status-labels.ts`**
  ```ts
  import type { InvoiceDisplayStatus } from "./invoices";

  /** One place for status wording and colour. Words match what the app already shows. */
  export type Tone = "neutral" | "accent" | "danger" | "success" | "warning";
  type Label = { label: string; tone: Tone };

  export const SALES_STATUS: Record<InvoiceDisplayStatus, Label> = {
    draft: { label: "Luonnos", tone: "neutral" },
    sent: { label: "Lähetetty", tone: "accent" },
    overdue: { label: "Myöhässä", tone: "danger" },
    paid: { label: "Maksettu", tone: "success" },
    credited: { label: "Hyvitetty", tone: "neutral" },
  };

  export const PURCHASE_STATUS: Record<"open" | "overdue" | "paid" | "cancelled", Label> = {
    open: { label: "Avoin", tone: "accent" },
    overdue: { label: "Myöhässä", tone: "danger" },
    paid: { label: "Maksettu", tone: "success" },
    cancelled: { label: "Mitätöity", tone: "neutral" },
  };
  ```

- [ ] **Step 4: Components.** One file each in `app/src/components/ds/`. Files with hooks start with `"use client";`.

  `PageTitle.tsx`
  ```tsx
  import type { ReactNode } from "react";

  export function PageTitle({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
    return (
      <header className="mb-5 flex items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <h1 className="text-[32px] font-bold leading-tight tracking-[-0.02em] text-ink [text-wrap:balance]">{title}</h1>
          {subtitle ? <p className="mt-0.5 text-[15px] text-ink-2">{subtitle}</p> : null}
        </div>
        {action ? <div className="shrink-0 pb-1">{action}</div> : null}
      </header>
    );
  }
  ```

  `Card.tsx`
  ```tsx
  import type { ReactNode } from "react";

  export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
    return <div className={`rounded-card border border-line bg-surface p-4 ${className}`}>{children}</div>;
  }
  ```

  `Section.tsx`
  ```tsx
  import type { ReactNode } from "react";

  export function Section({ title, count, action, children, className = "" }: {
    title?: string; count?: number; action?: ReactNode; children: ReactNode; className?: string;
  }) {
    const aside = action ?? (count !== undefined ? <span className="tabular-nums">{count}</span> : null);
    return (
      <section className={`mt-6 first:mt-0 ${className}`}>
        {title || aside ? (
          <div className="mb-2 flex items-baseline justify-between gap-3 px-1 text-[13px] text-ink-2">
            {title ? <h2 className="font-normal">{title}</h2> : <span />}
            {aside}
          </div>
        ) : null}
        <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">{children}</div>
      </section>
    );
  }
  ```

  `ListRow.tsx`
  ```tsx
  import Link from "next/link";
  import type { ReactNode } from "react";

  const AMOUNT_TONE = { default: "text-ink", positive: "text-success", negative: "text-ink" } as const;

  export function ListRow({ title, amount, amountTone = "default", secondary, trailing, leading, href, onClick, ariaLabel }: {
    title: string; amount?: ReactNode; amountTone?: keyof typeof AMOUNT_TONE; secondary?: ReactNode;
    trailing?: ReactNode; leading?: ReactNode; href?: string; onClick?: () => void; ariaLabel?: string;
  }) {
    const body = (
      <>
        {leading ? (
          <span aria-hidden className="pointer-events-none flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-canvas text-ink-2">
            {leading}
          </span>
        ) : null}
        <span className="pointer-events-none min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3 text-[15px] font-medium text-ink">
            <span className="min-w-0 truncate">{title}</span>
            {amount !== undefined ? <span className={`shrink-0 tabular-nums ${AMOUNT_TONE[amountTone]}`}>{amount}</span> : null}
          </span>
          {secondary || trailing ? (
            <span className="mt-0.5 flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-[13px] text-ink-2">{secondary}</span>
              {trailing ? <span className="pointer-events-auto relative z-10 shrink-0">{trailing}</span> : null}
            </span>
          ) : null}
        </span>
      </>
    );
    const row = "relative flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left";
    if (href) {
      return (
        <div className={row}>
          <Link href={href} aria-label={ariaLabel ?? title} className="row-link active-press absolute inset-0" />
          {body}
        </div>
      );
    }
    if (onClick) {
      return (
        <div className={row}>
          <button type="button" onClick={onClick} aria-label={ariaLabel ?? title} className="row-link active-press absolute inset-0" />
          {body}
        </div>
      );
    }
    return <div className={row}>{body}</div>;
  }
  ```

  `ActionPill.tsx`
  ```tsx
  import Link from "next/link";
  import type { ReactNode } from "react";

  const PILL = "active-press inline-flex min-h-9 items-center rounded-full bg-accent-soft px-3 text-[13px] font-semibold text-accent";

  export function ActionPill({ children, href, onClick, ariaLabel }: { children: ReactNode; href?: string; onClick?: () => void; ariaLabel?: string }) {
    if (href) return <Link href={href} aria-label={ariaLabel} className={PILL}>{children}</Link>;
    return <button type="button" onClick={onClick} aria-label={ariaLabel} className={PILL}>{children}</button>;
  }
  ```

  `StatusTag.tsx`
  ```tsx
  import type { ReactNode } from "react";
  import type { Tone } from "@/lib/status-labels";

  const TONE: Record<Tone, string> = {
    neutral: "bg-canvas text-ink-2",
    accent: "bg-accent-soft text-accent",
    danger: "bg-danger/10 text-danger",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
  };

  export function StatusTag({ tone, children, icon }: { tone: Tone; children: ReactNode; icon?: ReactNode }) {
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold ${TONE[tone]}`}>
        {icon ? <span aria-hidden className="flex">{icon}</span> : null}
        {children}
      </span>
    );
  }
  ```

  `FilterChips.tsx`
  ```tsx
  "use client";

  export function FilterChips<T extends string>({ label, items, value, onChange }: {
    label: string; items: { id: T; label: string; count?: number }[]; value: T; onChange: (id: T) => void;
  }) {
    return (
      <div role="group" aria-label={label} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {items.map((item) => {
          const selected = item.id === value;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(item.id)}
              className={`ds-chip active-press inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium ${
                selected ? "border-ink bg-ink text-canvas" : "border-line bg-surface text-ink"
              }`}
            >
              {item.label}
              {item.count !== undefined ? (
                <span className={`tabular-nums ${selected ? "text-canvas/70" : "text-ink-2"}`}>{item.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  }
  ```

  `SummaryCard.tsx`
  ```tsx
  import type { ReactNode } from "react";

  export function SummaryCard({ label, value, note, noteTone = "accent" }: { label: string; value: ReactNode; note?: ReactNode; noteTone?: "accent" | "muted" }) {
    return (
      <div className="rounded-card border border-line bg-surface p-4">
        <p className="text-[13px] text-ink-2">{label}</p>
        <p className="mt-0.5 text-[28px] font-bold tracking-[-0.02em] tabular-nums text-ink">{value}</p>
        {note ? <p className={`mt-0.5 text-sm ${noteTone === "accent" ? "text-accent" : "text-ink-2"}`}>{note}</p> : null}
      </div>
    );
  }
  ```

  `DetailHero.tsx`
  ```tsx
  import type { ReactNode } from "react";

  const TONE = { default: "text-ink", positive: "text-success", negative: "text-ink" } as const;

  export function DetailHero({ amount, amountTone = "default", title, meta, status, menu }: {
    amount?: ReactNode; amountTone?: keyof typeof TONE; title: string; meta?: ReactNode; status?: ReactNode; menu?: ReactNode;
  }) {
    return (
      <div className="relative select-text px-2 pb-5 pt-2 text-center">
        {menu ? <div className="absolute right-0 top-0">{menu}</div> : null}
        {amount !== undefined ? (
          <p className={`text-[40px] font-bold leading-tight tracking-[-0.02em] tabular-nums ${TONE[amountTone]}`}>{amount}</p>
        ) : null}
        <h1 className={`${amount !== undefined ? "mt-1 text-[17px]" : "text-[28px]"} font-semibold text-ink`}>{title}</h1>
        {meta ? <p className="mt-0.5 text-sm text-ink-2">{meta}</p> : null}
        {status ? <div className="mt-3 flex justify-center">{status}</div> : null}
      </div>
    );
  }
  ```

  `KeyValueList.tsx`
  ```tsx
  import type { ReactNode } from "react";

  export function KeyValueList({ rows }: { rows: { label: string; value: ReactNode }[] }) {
    return (
      <dl className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-3 px-4 py-3 text-[15px]">
            <dt className="text-ink-2">{row.label}</dt>
            <dd className="min-w-0 text-right font-medium text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  ```

  `Timeline.tsx`
  ```tsx
  import type { ReactNode } from "react";

  export function Timeline({ items }: { items: { title: string; meta?: ReactNode; tone?: "accent" | "muted" }[] }) {
    return (
      <ol className="rounded-card border border-line bg-surface px-4 py-1">
        {items.map((item, index) => (
          <li key={`${item.title}-${index}`} className="flex gap-3 py-2.5 text-sm">
            <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.tone === "accent" ? "bg-accent" : "bg-ink-2"}`} />
            <span>
              <span className="text-ink">{item.title}</span>
              {item.meta ? <span className="mt-0.5 block text-[13px] text-ink-2">{item.meta}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    );
  }
  ```

  `BottomActions.tsx`. It is fixed to the bottom of the frame; Task 2 hides the tab bar on detail pages and exposes `--app-sidebar-width` so this bar clears the desktop sidebar.
  ```tsx
  import type { ReactNode } from "react";

  export function BottomActions({ children }: { children: ReactNode }) {
    return (
      <>
        <div aria-hidden className="h-32" />
        <div
          className="fixed inset-x-0 z-30 bg-canvas/95 px-4 pt-3 backdrop-blur-sm md:left-[var(--app-sidebar-width,0px)]"
          style={{ bottom: "var(--usable-bottom, 0px)", paddingBottom: "calc(12px + var(--safe-bottom, 0px))" }}
        >
          <div className="mx-auto flex max-w-lg flex-col gap-2 md:max-w-3xl">{children}</div>
        </div>
      </>
    );
  }
  ```

  `MoreMenu.tsx`
  ```tsx
  "use client";

  import { useId, useState } from "react";
  import BottomSheet from "@/components/BottomSheet";

  export function MoreMenu({ items, label = "Lisää toimintoja" }: {
    items: { label: string; onSelect: () => void; tone?: "danger"; disabled?: boolean }[]; label?: string;
  }) {
    const [open, setOpen] = useState(false);
    const titleId = useId();
    return (
      <>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="active-press flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface text-ink"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
        <BottomSheet isOpen={open} onClose={() => setOpen(false)} title="Toiminnot" labelledBy={titleId} heightClass="max-h-[70dvh]">
          <div className="px-3 py-2 sheet-safe-bottom">
            <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className={`active-press flex min-h-12 w-full items-center px-4 text-left text-[15px] disabled:opacity-50 ${
                    item.tone === "danger" ? "text-danger" : "text-ink"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </BottomSheet>
      </>
    );
  }
  ```
  Check `BottomSheet`'s actual prop names and that `labelledBy` is applied to the title element's id before relying on it; adapt the call (not the BottomSheet file) if they differ.

  `index.ts`: re-export all of the above.

- [ ] **Step 5: GREEN.** `npx vitest run src/lib/status-labels.test.ts src/components/ds/ds.test.ts` → PASS. Then `npm run typecheck && npm run lint && npm test` (baselines).
- [ ] **Step 6: Commit** `feat(ds): tokens, status labels and shared components` (+ trailer).

---

### Task 2: Shell and global controls in the new look

**Files:** `app/src/app/globals.css`, `app/src/components/AppShell.tsx`, `app/src/components/control-styles.ts`, `app/src/components/ui.tsx`, `app/src/components/SettingsList.tsx`, `app/src/components/BottomSheet.tsx` (visual classes only), `app/src/components/ScreenState.tsx` + `AsyncState.tsx` (visual classes only).

- [ ] **Step 1: Parked bug from phase 1 (ledger R15), test-first where possible.** In AppShell's edge-swipe `useEffect`, the dependency array lists `back` (a fresh object each render). Depend on `back?.href` (a string) instead, and read the href inside the effect. Verify with a comment-free diff that no other effect lists an object recreated per render.
- [ ] **Step 2: Canvas.** `body` and `.app-frame`/`.app-main` backgrounds become `var(--color-canvas)`; header and tab bar become `bg-surface` with `border-line` hairlines (keep blur and all layout CSS: safe areas, `--app-tab-height`, keyboard handling untouched). `themeColor` in `layout.tsx` becomes `#f6f3ef`.
- [ ] **Step 3: Detail pages hide the tab bar.** When `matchNav(pathname)?.kind === "detail"`, AppShell does not render the tab bar and sets `data-tabs="hidden"` on `.app-frame`; `globals.css` removes the tab-bar bottom padding from `.app-main` under that attribute. Expose the desktop sidebar width as a CSS variable `--app-sidebar-width` on `.app-frame` (0px below 768px, the existing sidebar width at ≥768px) so `BottomActions` clears it.
- [ ] **Step 4: Controls.** `control-styles.ts`: `controlClass` → `box-border block w-full min-w-0 max-w-full px-3 min-h-12 rounded-card border border-line bg-surface text-[16px] text-ink`; `chipClass` → same look as `FilterChips` (selected `border-ink bg-ink text-canvas`, idle `border-line bg-surface text-ink`, `ds-chip`, `min-h-11`, no `hover:` feedback); `BUTTON_VARIANTS` → primary `bg-ink text-canvas`, secondary `bg-surface text-ink border border-line`, danger `bg-surface text-danger border border-danger/30`, ghost `bg-transparent text-accent`; `buttonClass` base → `active-press inline-flex min-h-12 items-center justify-center gap-2 rounded-card px-4 text-[15px] font-semibold disabled:opacity-60`. `ui.tsx` `Field` label → 13px `text-ink-2`, error text stays `text-danger`.
- [ ] **Step 5: SettingsList** becomes the Section look: group label sentence case 13px `text-ink-2` (no uppercase/tracking), card `rounded-card border border-line bg-surface divide-y divide-line` without shadow, row title 15px/500 `text-ink`, hint 13px `text-ink-2`.
- [ ] **Step 6: BottomSheet / states.** Sheet panel `bg-canvas`, title 20px/700 `text-ink`, grabber `bg-line`; do not touch its gesture, focus-trap or timing code. `EmptyState`/`ConnectionNotice`/`LoadingState`/`SkeletonList`: replace `bg-white`/shadows/uppercase with tokens.
- [ ] **Step 7: The Lisää and profile sheets in AppShell** match mockup `04-lisaa-sheet.png`: primary row `bg-ink text-canvas rounded-card` with the camera icon and the hint "Luetaan automaattisesti ja liitetään tapahtumaan"; other rows in one `Section`-style card with leading icons (file, invoice, mail). Keep the requestLeave guard and accessible names.
- [ ] **Step 8: Verify.** Typecheck, lint, unit baseline. Screenshots (390 and 1440) of `/dashboard`, `/asetukset`, `/laskut/uusi`, the Lisää sheet, the profile sheet and one detail page (`/laskut/<id>` from the demo data) showing no tab bar. Commit `feat(shell): new look for shell, sheets and shared controls`.

---

### Task 3: Myynti list

**Files:** `app/src/app/laskut/page.tsx` (+ any child component it renders).

Target: mockup `03-myynti.png`.
- `PageTitle` "Myynti", `action` = the existing "Uusi lasku" control restyled as a small ink pill with a plus icon (same route, same accessible name).
- `SummaryCard` label "Avoinna", value = open receivables, note = "<overdue amount> myöhässä" (hidden when nothing is overdue). Keep the existing aging buckets below as a compact `Card` with four `KeyValueList`-style cells, or fold them into the summary note if the page already shows them elsewhere; do not drop the data.
- `FilterChips` label "Suodata laskut" with the existing filters and live counts: Kaikki, Myöhässä, Luonnokset, Avoimet (sent, not overdue), Maksetut, and Hyvitetyt only when at least one credited invoice exists. Keep the existing `status` URL query behaviour (`report-drill.ts` links into it).
- With "Kaikki": invoices grouped by display status in this order: Myöhässä, Luonnokset, Odottaa maksua (sent), Maksetut, Hyvitetyt; each group a `Section` with count. With a filter: only that group.
- Each invoice a `ListRow`: title = customer name, amount = total, secondary = "Lasku N, eräpäivä d.m." (overdue: "erääntyi d.m."), trailing = `ActionPill` "Muistuta" for overdue and "Lähetä" for drafts linking to the invoice detail, else `StatusTag` from `SALES_STATUS`.
- "Kohdista maksut" stays reachable: a secondary button under the summary card.
- The "Myynnin rekisterit" group from phase 1 becomes a `Section` without a title with two `ListRow`s with leading icons: Asiakkaat (count), Toistuvat laskut (count).
- Keep: loading/empty/error states (restyled), search if present, the `customerId` filter from `/asiakkaat` links.
- Verify, screenshots, commit `feat(myynti): new list look with grouped invoices and counted filters`.

---

### Task 4: Invoice detail and new invoice

**Files:** `app/src/app/laskut/[id]/page.tsx`, `app/src/app/laskut/uusi/page.tsx`, `app/src/components/invoices/InvoiceForm.tsx`.

Detail target: mockup `07-lasku-detail.png`.
- `DetailHero`: amount = total, title = customer name (a link to `/asiakkaat/<id>` rendered in `meta` as "Asiakas" or make the title area link; keep one h1), meta = "Lasku N, viite R" (credit note: "Hyvityslasku N"), status = `StatusTag` (overdue: "Myöhässä X päivää"; otherwise `SALES_STATUS`), `menu` = `MoreMenu` holding every rare action the page has today (PDF, copy/duplicate, credit note, delete, and any other found in the function inventory).
- `KeyValueList`: Päivätty, Eräpäivä, Viite, rows summary (line count and first line), ALV per rate, Yhteensä.
- Existing payment list, reminders and sends become `Section`s ("Maksut", "Muistutukset") and a `Timeline` "Historia" built from the invoice's activity data already on the page.
- `BottomActions`: exactly one primary by status: draft → "Lähetä" (existing send flow), overdue → "Lähetä muistutus" (existing reminder flow), sent → "Kirjaa maksu" (existing payment form); secondary text action "Kirjaa maksu käsin" when the primary is not already the payment action. Forms that used to be inline open in a `BottomSheet` or stay inline in a `Section`; they must keep their labels (e2e uses `getByLabel`).
- Uusi lasku: `PageTitle` "Uusi lasku"; form fields in `Section`/`Card` groups with the new `controlClass`; save and cancel in `BottomActions`.
- Verify (function inventory mandatory), screenshots, commit `feat(laskut): detail page pattern and new invoice form`.

---

### Task 5: Customers and recurring invoices

**Files:** `app/src/app/asiakkaat/page.tsx`, `app/src/app/asiakkaat/[id]/page.tsx`, `app/src/components/invoices/CustomerForm.tsx`, `app/src/app/toistuvat/page.tsx`.
- Lists: `PageTitle` ("Asiakkaat", "Toistuvat laskut") with the create action as the title `action`; rows as `ListRow` (customer: name, open balance as amount, secondary Y-tunnus and payment term; recurring: customer, amount, secondary interval and next date, `StatusTag` for paused/active using the page's existing words); create/edit forms in a `BottomSheet` or `Card` with the new controls.
- Customer detail: `DetailHero` (amount = open balance, title = name, meta = Y-tunnus), `KeyValueList` for contact data, `Section` "Laskut" with `ListRow`s linking to invoices, `MoreMenu` for edit/archive, `BottomActions` primary "Uusi lasku tälle asiakkaalle" if that action exists today (else the page's most frequent action).
- Verify, screenshots, commit `feat(myynti): customers and recurring invoices in the new look`.

---

### Task 6: Kirjanpito root and its settings-like pages

**Files:** `app/src/app/kirjanpito/page.tsx`, `kirjanpito/alv/page.tsx`, `kirjanpito/ostolaskut/page.tsx`, `kirjanpito/pankkitilit/page.tsx`, `kirjanpito/kaudet/page.tsx`, `app/src/components/BooksLockCard.tsx`, `app/src/components/BankConnectCard.tsx`, `app/src/components/bank/*` (visual only).
- Root: target mockup `02-kirjanpito.png` lower half. `PageTitle` "Kirjanpito". Section "Tapahtumat ja kuitit" (Kuitit, Tapahtumat, Täsmäytys, Työt ja poikkeukset) and Section "Ilmoitukset ja kaudet" as `ListRow`s with leading icons and live values where an existing endpoint already provides them cheaply (ALV amount and due period, open purchase invoice count, bank name, locked-through month); no new API in this task. (Phase 3 replaces the first section with the transaction list.)
- ALV: `PageTitle` "ALV-ilmoitus" with period switch as `FilterChips` (Kuukausi/Neljännes) and the period select; each OmaVero field group a `Section` with `KeyValueList` rows (field number shown small before the label); drill links kept.
- Ostolaskut: same list pattern as Task 3 with `PURCHASE_STATUS`, filters with counts, create form in a sheet or card.
- Pankkitilit: `SummaryCard` total balance, accounts as `ListRow`s, month balances in `Section`, BankConnectCard restyled (keep its `id="pankkiyhteys"`).
- Kaudet: `PageTitle` "Suljetut kaudet", BooksLockCard restyled, precheck items as `ListRow`s.
- Verify, screenshots, commit `feat(kirjanpito): root, ALV, purchases, bank accounts and periods in the new look`.

---

### Task 7: Receipts list, work queue, reconciliation

**Files:** `app/src/app/kuitit/page.tsx` (1285 lines), `app/src/components/ReviewQueue.tsx`, `app/src/app/tyot/page.tsx`, `app/src/app/pankki/taydennys/page.tsx`.
- `kuitit/page.tsx` may be split into focused components under `app/src/app/kuitit/` (e.g. `ReceiptFilters.tsx`, `ReceiptRow.tsx`, `BulkBar.tsx`) as part of this task; behaviour, URL query handling, bulk select and review queue must stay identical.
- Receipts: `PageTitle` "Kuitit"; existing tab filters become `FilterChips` with counts **unless an e2e/unit test relies on role `tab`** (grep first; if so keep `role="tablist"`/`tab` semantics and only restyle); rows as `ListRow` (vendor, amount, secondary date and category, `StatusTag` "Ei linkitystä"/"Linkitetty"/review states using the page's existing words, collected into new entries in `status-labels.ts` with a test); edit/delete move into the row's detail or a `MoreMenu`, bulk actions in a sticky bar using the new buttons.
- Työt: `PageTitle` "Työt ja poikkeukset", job status in a `Card`, exception queue as `FilterChips` + `ListRow`s with `ActionPill` "Avaa".
- Täsmäytys: two `Section`s ("Pankkitapahtumat", "Kuitit ilman linkkiä") of `ListRow`s.
- Verify, screenshots, commit `feat(kirjanpito): receipts, work queue and reconciliation in the new look`.

---

### Task 8: Receipt detail, transactions, statement detail

**Files:** `app/src/components/ReceiptEditor.tsx` (1360 lines), `app/src/components/ReceiptMatchPanel.tsx`, `app/src/components/ReceiptPreview.tsx`, `app/src/app/pankki/tapahtumat/TapahtumatClient.tsx`, `app/src/app/pankki/tapahtumat/[id]/StatementDetailClient.tsx`, `app/src/components/StatementDetailView.tsx`, `app/src/components/StatementSummaryCards.tsx`.
- Receipt detail (existing receipt): `DetailHero` (amount, vendor, date and category, `StatusTag` for review/link state), preview image in a `Card`, fields grouped in `Section`s, match panel restyled as a `Section` "Pankkitapahtuma", `MoreMenu` for delete/duplicate-related actions, `BottomActions` primary "Tallenna" (or "Hyväksy" for a pending review). New receipt (`/kuitit/uusi`): `PageTitle` "Uusi kuitti", upload area as a `Card`, same form sections. Splitting ReceiptEditor into sub-components is allowed; its save/upload/match behaviour must not change.
- Tapahtumat list: `PageTitle` "Tapahtumat", filters as `FilterChips`/selects in the new controls, statements as `ListRow`s, file import in a `Section` "Tuo tiliote tiedostona".
- Statement detail: `DetailHero` (period, file, account), summary cards → `SummaryCard`s in a 2-column grid, transactions as `ListRow`s with document-state `StatusTag`s (new `status-labels.ts` entry, tested), link/ignore actions as `ActionPill`s, delete in `MoreMenu`.
- Verify, screenshots, commit `feat(kirjanpito): receipt editor, transactions and statement detail in the new look`.

---

### Task 9: Koti and Raportit

**Files:** `app/src/app/dashboard/DashboardClient.tsx`, `app/src/app/raportit/page.tsx`, `app/tests/e2e/app.spec.ts` (heading assertion only).
- Koti (visual only; phase 4 adds tasks and progress): `PageTitle` title = current month name capitalised ("Syyskuu"), subtitle = business name if present else the greeting; month switcher as a small chevron control under the title; Tulot/Menot/ALV-arvio as `SummaryCard`s (2-column grid; ALV card links to `/kirjanpito/alv?period=`); "Kuittien linkitys" and quick actions as `ListRow`s in a `Section`; remove the old greeting heading. Update the e2e assertion `getByRole("heading", { name: /Liisa!/ })` in `app.spec.ts` to the new title (the month heading).
- Raportit: `PageTitle` "Raportit"; year switch; P&L months as `Section`s with `KeyValueList`; category tables as `ListRow`s; downloads as `ListRow`s with a download icon.
- Verify, screenshots, commit `feat(koti,raportit): new look for home and reports`.

---

### Task 10: Settings, sign-in screens, bank return

**Files:** `app/src/app/asetukset/**/page.tsx` (root + 12), `app/src/components/{SellerProfileCard,BiometricUnlockCard,SelectMenu,OnboardingModal}.tsx` (visual only), `app/src/app/login/{page,LoginForm}.tsx`, `app/src/app/unohtunut-salasana/page.tsx`, `app/src/app/palauta-salasana/page.tsx`, `app/src/app/vahvista-sahkoposti/page.tsx`, `app/src/app/bank/callback/page.tsx`.
- Every settings page: `PageTitle` with its registry label; groups via the restyled `SettingsList`/`Section`; forms with the new controls; save buttons in `BottomActions` only where the page is a single form.
- Sign-in screens: centred single column on `bg-canvas`, app name as a 32px bold title, form in a `Card`, primary button full width `bg-ink`. Keep every label (`Sähköposti`, `Salasana`, button `Kirjaudu sisään`).
- Bank return: `DetailHero`-style centred status, one primary button "Takaisin pankkitileihin".
- Verify, screenshots, commit `feat(asetukset,auth): settings and sign-in screens in the new look`.

---

### Task 11: Header without title, cleanup, full audit

**Files:** `app/src/components/AppShell.tsx`, `app/src/components/SkeletonCard.tsx` (delete if still unused), `app/src/app/globals.css` (remove unused `.glass`, `.glass-dark`, `.hover-lift`, `.pulse-glow` only if grep shows no users), `app/tests/e2e/app.spec.ts` (only if a heading/name changed), `app/docs/appearance.md` (document tokens and components).
- Shell header renders no title text (back, assistant, avatar only) now that every page renders `PageTitle` or `DetailHero`. Before removing it, assert with a script that every route in `NAV` renders exactly one `h1` (walk all routes with Chrome, signed in, 390×844; list any route without an h1 and fix it).
- Full audit: screenshots of every route in `NAV` plus the Lisää, profile and one `MoreMenu` sheet at 390×844 and 1440×900. For each, check the Global Constraints list (tokens only, no shadows on cards, no uppercase eyebrows, one back, one h1, touch targets) and fix violations. Produce `audit.md` in the scratchpad with one line per route: pass/fail and screenshot path.
- `grep -rn "rounded-2xl\|rounded-3xl\|shadow-sm\|uppercase\|tracking-wide" app/src --include=*.tsx` → every remaining hit is either justified in the report or fixed.
- Verify (typecheck, lint, unit, `npm run test:integration` if the Windows shim note in the ledger applies, report it), commit `chore(ds): header without title, remove dead styles, document the design system`.
