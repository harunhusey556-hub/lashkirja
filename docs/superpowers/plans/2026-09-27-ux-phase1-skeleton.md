# UX Restructure, Phase 1 (Skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 7-root navigation with the approved 4-root skeleton (Koti, Myynti, +, Kirjanpito, Raportit; Asetukset behind the avatar), one labelled back button, moved routes with redirects, and deny-by-default page protection.

**Architecture:** `src/lib/navigation.ts` stays the single registry; roots gain a `placement` (`tab` or `avatar`) instead of `mobile`. The shell (`AppShell.tsx`) renders tab roots plus a centre "+" sheet, puts Asetukset in the avatar sheet, and renders the only back button, labelled with the registry parent. Pages that move get a `git mv` plus a `next.config.ts` redirect; `proxy.ts` protects every page except an explicit public list. Page *content* is unchanged in this phase except where a removed nav helper was used.

**Tech Stack:** Next.js 16.2 App Router (read `node_modules/next/dist/docs/` before touching routing: this is not the Next.js from training data), React 19, TypeScript, Tailwind v4, Vitest 4, Playwright 1.62.

**Spec:** `docs/superpowers/specs/2026-09-27-ux-restructure-design.md` (§2, §4 and §8 step 1).

## Global Constraints

- Tab roots, in order: `Koti` (`/dashboard`), `Myynti` (`/laskut`), `Kirjanpito` (`/kirjanpito`), `Raportit` (`/raportit`). Mobile tab bar shows a "+" button between Myynti and Kirjanpito.
- Asetukset (`/asetukset`) is a root with `placement: "avatar"`: not in the tab bar, not in the sidebar's main list; opened from the avatar sheet and the sidebar footer.
- A detail/workspace/settings page shows exactly one back control: the shell's, labelled with the registry parent's label. No `PageHeader`, breadcrumbs, `SectionTabs` or `WorkspaceLinks` remain.
- Redirects in this phase are `permanent: false` (307). Destinations change again in phases 2 and 3; a cached 308 would pin users to a wrong page. Switch to `permanent: true` in phase 6.
- UI copy is Finnish; do not use the em dash character in new copy.
- Out of scope for this phase (later plans): hiding the tab bar on detail pages and the fixed bottom action (spec §2.2 rule 4, §3.5), the single transaction list, Koti tasks, the Myynti filter row, and the real "+" sheet behaviour.
- All commands run from `app/`. Every task ends with `npm run typecheck && npm test` green. Do not pipe test output through `tail`/`head`: read the whole summary.
- Commit trailer (every commit):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Dt441ofXM5z9eZZdckoQC9
  ```
- Known environment-only unit failures on Windows (not regressions, do not "fix"): `backup-script.test.ts` (3, no `sqlite3` CLI), `db-permissions.test.ts` (1, POSIX modes), `db-upgrade.test.ts` (1, spawns `.bin/prisma` without `.cmd`). Baseline: 5 failed / 510 passed.

---

### Task 1: Registry v2, moved routes, redirects

**Files:**
- Modify: `src/lib/navigation.ts` (rewrite `NAV`, helpers, validator)
- Modify: `src/lib/navigation.test.ts`
- Move: `src/app/alv-raportti/page.tsx` → `src/app/kirjanpito/alv/page.tsx`
- Move: `src/app/ostolaskut/page.tsx` → `src/app/kirjanpito/ostolaskut/page.tsx`
- Move: `src/app/asetukset/kirjanpito/page.tsx` → `src/app/kirjanpito/kaudet/page.tsx`
- Move: `src/app/pankki/tilit/page.tsx` → `src/app/kirjanpito/pankkitilit/page.tsx`
- Delete: `src/app/pankki/page.tsx`, `src/app/asetukset/pankkiyhteys/page.tsx`, `src/components/PageHeader.tsx`, `src/components/SectionTabs.tsx`
- Create: `src/app/kirjanpito/page.tsx`
- Modify: `src/app/pankki/tapahtumat/TapahtumatClient.tsx:7-8,24,210-214`, `src/app/pankki/tapahtumat/[id]/StatementDetailClient.tsx:6,58-66`, `src/app/pankki/taydennys/page.tsx:6-10,67-71`, `src/app/kirjanpito/pankkitilit/page.tsx` (was tilit: lines 15-17, 241-257)
- Modify: `next.config.ts:92-97` (redirects)
- Modify: `src/lib/report-drill.ts:39-41`, `src/lib/chat-honesty.ts:22-29,55-62`, `src/lib/chat-honesty.test.ts:51,61,63,100,102`
- Modify: `src/app/dashboard/DashboardClient.tsx:406,412`, `src/app/bank/callback/page.tsx:61,88-93`
- Modify (bridge only): `src/components/AppShell.tsx:37-44` imports and the three `rootNav/primaryRoots/moreRoots` call sites

**Interfaces:**
- Produces (used by Task 3):
  ```ts
  export type NavPlacement = "tab" | "avatar";
  export type NavEntry = { id: string; kind: NavKind; label: string; path: string; parent?: string; placement?: NavPlacement };
  export function tabRoots(entries?: readonly NavEntry[]): NavEntry[];   // Koti, Myynti, Kirjanpito, Raportit
  export function avatarRoot(entries?: readonly NavEntry[]): NavEntry;   // Asetukset
  export function backTarget(pathname: string, entries?: readonly NavEntry[]): { label: string; href: string } | null;
  export function shellShowsBack(pathname: string, entries?: readonly NavEntry[]): boolean;
  export function matchNav(pathname: string, entries?: readonly NavEntry[]): NavEntry | null; // unchanged
  export function rootIsActive(pathname: string, rootId: string, entries?: readonly NavEntry[]): boolean; // unchanged
  export function statementListHref(search: string): string; // unchanged
  ```
- Removed: `rootNav`, `primaryRoots`, `moreRoots`, `bankTabs`, `activeBankTab`, `NavEntry.mobile`.

- [ ] **Step 1: Write the failing registry tests**

Replace the `describe("navigation registry", ...)` block in `src/lib/navigation.test.ts` (keep the imports block's `readdirSync/statSync/path`, `APP_DIR`, `BARE_ROUTES`, `pagesIn` exactly as they are) and change the named imports to:

```ts
import {
  NAV,
  avatarRoot,
  backTarget,
  matchNav,
  navigationViolations,
  shellShowsBack,
  statementListHref,
  tabRoots,
  type NavEntry,
} from "./navigation";
```

```ts
describe("navigation registry", () => {
  it("accepts the locked product map", () => {
    expect(navigationViolations()).toEqual([]);
  });

  it("has four tab roots in order and Asetukset behind the avatar", () => {
    expect(tabRoots().map((entry) => entry.label)).toEqual(["Koti", "Myynti", "Kirjanpito", "Raportit"]);
    expect(tabRoots().map((entry) => entry.path)).toEqual(["/dashboard", "/laskut", "/kirjanpito", "/raportit"]);
    expect(avatarRoot().id).toBe("asetukset");
    expect(avatarRoot().path).toBe("/asetukset");
  });

  it("fails when a fifth tab root is added", () => {
    const extra: NavEntry = { id: "pankki", kind: "root", label: "Pankki", path: "/pankki", placement: "tab" };
    expect(navigationViolations([...NAV, extra]).some((error) => error.includes("tab roots"))).toBe(true);
  });

  it("fails when a non-root claims a placement", () => {
    const planted: NavEntry = {
      id: "saannot",
      kind: "workspace",
      label: "Säännöt",
      path: "/kirjanpito/saannot",
      parent: "kirjanpito",
      placement: "tab",
    };
    expect(navigationViolations([...NAV, planted]).some((error) => error.includes("placement"))).toBe(true);
  });

  it("fails on a third menu level", () => {
    const nested: NavEntry = {
      id: "kuitit-saannot",
      kind: "workspace",
      label: "Säännöt",
      path: "/kuitit/saannot",
      parent: "kuitit",
    };
    expect(navigationViolations([...NAV, nested]).some((error) => error.includes("3-level"))).toBe(true);
  });

  it("fails when a detail has no parent", () => {
    const orphan: NavEntry = { id: "irrallinen", kind: "detail", label: "Irrallinen", path: "/irrallinen/:id" };
    expect(navigationViolations([...NAV, orphan]).some((error) => error.includes("without parent"))).toBe(true);
  });

  it("fails when one route has two canonical nav paths", () => {
    const alias: NavEntry = { id: "alv-alias", kind: "workspace", label: "ALV", path: "/kirjanpito/alv", parent: "raportit" };
    expect(navigationViolations([...NAV, alias]).some((error) => error.includes("duplicate path"))).toBe(true);
  });

  it("classifies every product page", () => {
    const missing = pagesIn(APP_DIR, "").filter((route) => !BARE_ROUTES.has(route) && !matchNav(route));
    expect(missing).toEqual([]);
  });

  it("keeps the statement list query across detail", () => {
    expect(statementListHref("?month=2026-03&account=acc-1&q=holvi&unrelated=1")).toBe(
      "/pankki/tapahtumat?month=2026-03&account=acc-1&q=holvi"
    );
    expect(statementListHref("")).toBe("/pankki/tapahtumat");
  });

  it("shows the shell back on every non-root page, never on a root", () => {
    for (const root of [...tabRoots(), avatarRoot()]) {
      expect(shellShowsBack(root.path)).toBe(false);
    }
    expect(shellShowsBack("/kirjanpito/alv")).toBe(true);
    expect(shellShowsBack("/pankki/tapahtumat")).toBe(true);
    expect(shellShowsBack("/asiakkaat")).toBe(true);
    expect(shellShowsBack("/asetukset/profiili")).toBe(true);
  });

  it("labels back with the registry parent", () => {
    expect(backTarget("/kirjanpito/alv")).toEqual({ label: "Kirjanpito", href: "/kirjanpito" });
    expect(backTarget("/pankki/tapahtumat/abc")).toEqual({ label: "Tapahtumat", href: "/pankki/tapahtumat" });
    expect(backTarget("/asiakkaat/42")).toEqual({ label: "Asiakkaat", href: "/asiakkaat" });
    expect(backTarget("/asiakkaat")).toEqual({ label: "Myynti", href: "/laskut" });
    expect(backTarget("/asetukset/tili/salasana")).toEqual({ label: "Tili", href: "/asetukset/tili" });
    expect(backTarget("/dashboard")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/navigation.test.ts`
Expected: FAIL, `tabRoots`/`avatarRoot`/`backTarget` are not exported.

- [ ] **Step 3: Rewrite the registry**

In `src/lib/navigation.ts`, replace everything from `export type NavKind` down to (not including) `function segments(` with:

```ts
export type NavKind = "root" | "workspace" | "detail" | "settings";

/** Roots only. `tab` = tab bar and sidebar; `avatar` = opened from the avatar sheet. */
export type NavPlacement = "tab" | "avatar";

export type NavEntry = {
  id: string;
  kind: NavKind;
  label: string;
  /** Canonical path. A `:param` segment matches one URL piece. */
  path: string;
  parent?: string;
  placement?: NavPlacement;
};

export const NAV: readonly NavEntry[] = [
  { id: "etusivu", kind: "root", label: "Koti", path: "/dashboard", placement: "tab" },
  { id: "myynti", kind: "root", label: "Myynti", path: "/laskut", placement: "tab" },
  { id: "kirjanpito", kind: "root", label: "Kirjanpito", path: "/kirjanpito", placement: "tab" },
  { id: "raportit", kind: "root", label: "Raportit", path: "/raportit", placement: "tab" },
  { id: "asetukset", kind: "root", label: "Asetukset", path: "/asetukset", placement: "avatar" },

  { id: "kuitit", kind: "workspace", label: "Kuitit", path: "/kuitit", parent: "kirjanpito" },
  { id: "kuitit-uusi", kind: "detail", label: "Uusi kuitti", path: "/kuitit/uusi", parent: "kuitit" },
  { id: "kuitti", kind: "detail", label: "Kuitti", path: "/kuitit/:id", parent: "kuitit" },
  { id: "pankki-tapahtumat", kind: "workspace", label: "Tapahtumat", path: "/pankki/tapahtumat", parent: "kirjanpito" },
  { id: "pankki-tapahtuma", kind: "detail", label: "Tiliote", path: "/pankki/tapahtumat/:id", parent: "pankki-tapahtumat" },
  { id: "pankki-taydennys", kind: "workspace", label: "Täsmäytys", path: "/pankki/taydennys", parent: "kirjanpito" },
  { id: "tyot", kind: "workspace", label: "Työt ja poikkeukset", path: "/tyot", parent: "kirjanpito" },
  { id: "alv", kind: "workspace", label: "ALV-ilmoitus", path: "/kirjanpito/alv", parent: "kirjanpito" },
  { id: "ostolaskut", kind: "workspace", label: "Ostolaskut", path: "/kirjanpito/ostolaskut", parent: "kirjanpito" },
  { id: "pankkitilit", kind: "workspace", label: "Pankkitilit", path: "/kirjanpito/pankkitilit", parent: "kirjanpito" },
  { id: "kaudet", kind: "workspace", label: "Suljetut kaudet", path: "/kirjanpito/kaudet", parent: "kirjanpito" },

  { id: "asiakkaat", kind: "workspace", label: "Asiakkaat", path: "/asiakkaat", parent: "myynti" },
  { id: "asiakas", kind: "detail", label: "Asiakas", path: "/asiakkaat/:id", parent: "asiakkaat" },
  { id: "toistuvat", kind: "workspace", label: "Toistuvat laskut", path: "/toistuvat", parent: "myynti" },
  { id: "lasku-uusi", kind: "detail", label: "Uusi lasku", path: "/laskut/uusi", parent: "myynti" },
  { id: "lasku", kind: "detail", label: "Lasku", path: "/laskut/:id", parent: "myynti" },

  { id: "asetukset-profiili", kind: "settings", label: "Profiili", path: "/asetukset/profiili", parent: "asetukset" },
  { id: "asetukset-yritys", kind: "settings", label: "Yritysmuoto & ALV", path: "/asetukset/yritys", parent: "asetukset" },
  { id: "asetukset-laskutus", kind: "settings", label: "Laskuttajan tiedot", path: "/asetukset/laskutus", parent: "asetukset" },
  { id: "asetukset-tili", kind: "settings", label: "Tili", path: "/asetukset/tili", parent: "asetukset" },
  { id: "asetukset-salasana", kind: "settings", label: "Vaihda salasana", path: "/asetukset/tili/salasana", parent: "asetukset-tili" },
  { id: "asetukset-laitteet", kind: "settings", label: "Laitteet", path: "/asetukset/tili/laitteet", parent: "asetukset-tili" },
  { id: "asetukset-turvallisuus", kind: "settings", label: "Turvallisuus", path: "/asetukset/turvallisuus", parent: "asetukset" },
  { id: "asetukset-lukitus", kind: "settings", label: "Näytön lukitus", path: "/asetukset/turvallisuus/lukitus", parent: "asetukset-turvallisuus" },
  { id: "asetukset-biometria", kind: "settings", label: "Face ID", path: "/asetukset/turvallisuus/biometria", parent: "asetukset-turvallisuus" },
  { id: "asetukset-tietosuoja", kind: "settings", label: "Tietosuoja", path: "/asetukset/tietosuoja", parent: "asetukset" },
  { id: "asetukset-sahkoposti", kind: "settings", label: "Sähköpostien tuonti", path: "/asetukset/sahkoposti", parent: "asetukset" },
  { id: "asetukset-ohje", kind: "settings", label: "Ohje ja tuki", path: "/asetukset/ohje", parent: "asetukset" },
];

const TAB_ROOT_IDS = ["etusivu", "myynti", "kirjanpito", "raportit"] as const;
const AVATAR_ROOT_ID = "asetukset";

function roots(entries: readonly NavEntry[]): NavEntry[] {
  return entries.filter((entry) => entry.kind === "root");
}

export function tabRoots(entries: readonly NavEntry[] = NAV): NavEntry[] {
  return roots(entries).filter((entry) => entry.placement === "tab");
}

export function avatarRoot(entries: readonly NavEntry[] = NAV): NavEntry {
  const root = roots(entries).find((entry) => entry.placement === "avatar");
  if (!root) throw new Error("navigation registry has no avatar root");
  return root;
}
```

Then, below `rootIsActive`, replace the whole `shellShowsBack` function (and its doc comment) with:

```ts
/** Every page below a root has exactly one back: the shell's. */
export function shellShowsBack(pathname: string, entries: readonly NavEntry[] = NAV): boolean {
  const match = matchNav(pathname, entries);
  return Boolean(match && match.kind !== "root");
}

/**
 * Where the shell back points when there is no in-app history, and what it
 * is called. A parent path with a `:param` cannot be rebuilt from the
 * registry alone, so it falls back to the parent's own parent.
 */
export function backTarget(
  pathname: string,
  entries: readonly NavEntry[] = NAV
): { label: string; href: string } | null {
  const match = matchNav(pathname, entries);
  if (!match || match.kind === "root" || !match.parent) return null;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let parent = byId.get(match.parent);
  while (parent && parent.path.includes(":") && parent.parent) {
    parent = byId.get(parent.parent);
  }
  return parent ? { label: parent.label, href: parent.path } : null;
}
```

Replace `navigationViolations` entirely with:

```ts
export function navigationViolations(entries: readonly NavEntry[] = NAV): string[] {
  const errors: string[] = [];
  const byId = new Map<string, NavEntry>();
  const paths = new Map<string, string>();

  for (const entry of entries) {
    if (entry.kind !== "root" && entry.kind !== "workspace" && entry.kind !== "detail" && entry.kind !== "settings") {
      errors.push(`${entry.id}: kind required`);
    }
    if (byId.has(entry.id)) errors.push(`duplicate id ${entry.id}`);
    byId.set(entry.id, entry);

    const canonical = entry.path.replace(/:[^/]+/g, ":param");
    const prior = paths.get(canonical);
    if (prior) errors.push(`duplicate path ${entry.path} (${prior} and ${entry.id})`);
    else paths.set(canonical, entry.id);

    if (entry.kind === "root" && entry.placement !== "tab" && entry.placement !== "avatar") {
      errors.push(`${entry.id}: root needs a placement`);
    }
    if (entry.kind !== "root" && entry.placement) {
      errors.push(`${entry.id}: only roots have a placement`);
    }
    if (entry.kind !== "root" && !entry.parent) {
      errors.push(`${entry.id}: ${entry.kind} without parent`);
    }
  }

  const tabs = tabRoots(entries).map((entry) => entry.id).join("|");
  if (tabs !== TAB_ROOT_IDS.join("|")) {
    errors.push(`tab roots must be ${TAB_ROOT_IDS.join("|")} (got ${tabs})`);
  }
  const avatars = roots(entries).filter((entry) => entry.placement === "avatar");
  if (avatars.length !== 1 || avatars[0].id !== AVATAR_ROOT_ID) {
    errors.push(`exactly one avatar root (${AVATAR_ROOT_ID}) is allowed`);
  }

  for (const entry of entries) {
    if (!entry.parent) continue;
    const parent = byId.get(entry.parent);
    if (!parent) {
      errors.push(`${entry.id}: unknown parent ${entry.parent}`);
      continue;
    }
    if (entry.kind === "workspace" && parent.kind !== "root") {
      errors.push(`${entry.id}: 3-level menu`);
    }
    const chain = ancestorChain(entry, byId);
    if (chain.filter((item) => item.kind === "workspace").length > 1) errors.push(`${entry.id}: 3-level menu`);
    if (entry.kind === "settings") {
      if (!chain.some((item) => item.id === AVATAR_ROOT_ID)) {
        errors.push(`${entry.id}: settings must live under Asetukset`);
      }
      if (chain.some((item) => item.kind === "workspace")) {
        errors.push(`${entry.id}: settings mixed into a workspace menu`);
      }
    }
  }

  return errors;
}
```

Delete the old `MORE_ROOT_IDS`, `BANK_TAB_LABELS`, `rootNav`, `primaryRoots`, `moreRoots`, `childrenOf`, `bankTabs`, `activeBankTab`. Keep `segments`, `routeMatches`, `matchNav`, `ancestorChain`, `rootIsActive`, `STATEMENT_QUERY_KEYS`, `statementListHref` unchanged. Update the file's top doc comment to: `Single navigation registry. The tab bar and sidebar render tab roots; Asetukset is the avatar root. New product features are workspace, detail, or settings entries, never a new root.`

- [ ] **Step 4: Move the pages**

```bash
mkdir -p src/app/kirjanpito/alv src/app/kirjanpito/ostolaskut src/app/kirjanpito/kaudet src/app/kirjanpito/pankkitilit
git mv src/app/alv-raportti/page.tsx src/app/kirjanpito/alv/page.tsx
git mv src/app/ostolaskut/page.tsx src/app/kirjanpito/ostolaskut/page.tsx
git mv src/app/asetukset/kirjanpito/page.tsx src/app/kirjanpito/kaudet/page.tsx
git mv src/app/pankki/tilit/page.tsx src/app/kirjanpito/pankkitilit/page.tsx
git rm -q src/app/pankki/page.tsx src/app/asetukset/pankkiyhteys/page.tsx src/components/PageHeader.tsx src/components/SectionTabs.tsx
ls src/app/alv-raportti src/app/ostolaskut src/app/asetukset/kirjanpito src/app/pankki/tilit src/app/asetukset/pankkiyhteys 2>&1
```

Expected: each `ls` reports "No such file or directory" (the directories held only `page.tsx`, verified 2026-09-27). If any directory still has files, stop and inspect them before continuing.

- [ ] **Step 5: Create the Kirjanpito hub (interim, replaced in phase 2)**

Create `src/app/kirjanpito/page.tsx`:

```tsx
import { SettingsGroup, SettingsRow } from "@/components/SettingsList";

/**
 * Phase 1 hub: one place for everything bookkeeping. Phase 2 replaces the
 * first group with the single transaction list (spec §3.2).
 */
export default function KirjanpitoPage() {
  return (
    <div className="space-y-6 pb-6">
      <SettingsGroup label="Tapahtumat ja kuitit">
        <SettingsRow href="/kuitit" label="Kuitit" hint="Kaikki kuitit ja niiden tila" />
        <SettingsRow href="/pankki/tapahtumat" label="Tapahtumat" hint="Tiliotteet ja yhdistetyn pankin tapahtumat" />
        <SettingsRow href="/pankki/taydennys" label="Täsmäytys" hint="Kuitit ja tapahtumat ilman linkkiä" />
        <SettingsRow href="/tyot" label="Työt ja poikkeukset" hint="Taustatyöt ja avoimet poikkeukset" />
      </SettingsGroup>
      <SettingsGroup label="Ilmoitukset ja kaudet">
        <SettingsRow href="/kirjanpito/alv" label="ALV-ilmoitus" hint="OmaVero-kentät kuukaudelle tai neljännekselle" />
        <SettingsRow href="/kirjanpito/ostolaskut" label="Ostolaskut" hint="Mitä olet velkaa ja milloin" />
        <SettingsRow href="/kirjanpito/pankkitilit" label="Pankkitilit" hint="Tilit, saldot ja pankkiyhteys" />
        <SettingsRow href="/kirjanpito/kaudet" label="Suljetut kaudet" hint="Sulje valmiit kuukaudet muutoksilta" />
      </SettingsGroup>
    </div>
  );
}
```

- [ ] **Step 6: Merge bank connection into Pankkitilit and drop the removed helpers from bank pages**

In `src/app/kirjanpito/pankkitilit/page.tsx`:
1. Delete the imports `import { PageHeader } from "@/components/PageHeader";`, `import { SectionTabs } from "@/components/SectionTabs";`, `import { activeBankTab, bankTabs } from "@/lib/navigation";`.
2. Add `import BankConnectCard from "@/components/BankConnectCard";` and `import { useProfile } from "@/app/asetukset/useProfile";`.
3. Delete the `<PageHeader ... />` element and the `<SectionTabs ... />` line (old lines 241-245).
4. Change the paragraph text `Kirjanpidon tilit ja kuukausien loppusaldot. Pankkiyhteyden asetukset ovat Asetuksissa.` to `Kirjanpidon tilit, kuukausien loppusaldot ja pankkiyhteys.`
5. Delete the `<Link href="/asetukset/pankkiyhteys" ...>+ Yhdistä</Link>` element.
6. Inside the component body, before the `return`, add `const { profile } = useProfile();`, and as the last child of the outermost `<div className="space-y-6 pb-6">` add:
   ```tsx
   {profile && (
     <section id="pankkiyhteys" aria-label="Pankkiyhteys">
       <BankConnectCard entityType={profile.entityType} />
     </section>
   )}
   ```
7. If `Link` is now unused, remove its import (typecheck/lint will tell you).

In `src/app/pankki/tapahtumat/TapahtumatClient.tsx`: delete the `PageHeader`, `SectionTabs` and `activeBankTab, bankTabs` imports and the `<PageHeader .../>` + `<SectionTabs .../>` elements (old lines 210-214).

In `src/app/pankki/taydennys/page.tsx`: same deletions (old lines 6-10 imports, 67-71 elements).

In `src/app/pankki/tapahtumat/[id]/StatementDetailClient.tsx`: delete the `PageHeader` import and the `<PageHeader .../>` element (old lines 58-66). Keep `listHref`; it is still used after delete (line 86). If lint reports it unused, keep the variable and inline it at its remaining use.

- [ ] **Step 7: Redirects and link targets**

In `next.config.ts`, replace the `redirects()` body with:

```ts
  async redirects() {
    // 307 on purpose: phases 2 and 3 move these destinations again.
    return [
      { source: "/tiliotteet", destination: "/pankki/tapahtumat", permanent: false },
      { source: "/tiliotteet/:id", destination: "/pankki/tapahtumat/:id", permanent: false },
      { source: "/pankkitilit", destination: "/kirjanpito/pankkitilit", permanent: false },
      { source: "/pankki", destination: "/kirjanpito", permanent: false },
      { source: "/pankki/tilit", destination: "/kirjanpito/pankkitilit", permanent: false },
      { source: "/alv-raportti", destination: "/kirjanpito/alv", permanent: false },
      { source: "/ostolaskut", destination: "/kirjanpito/ostolaskut", permanent: false },
      { source: "/asetukset/kirjanpito", destination: "/kirjanpito/kaudet", permanent: false },
      { source: "/asetukset/pankkiyhteys", destination: "/kirjanpito/pankkitilit", permanent: false },
    ];
  },
```

`src/lib/report-drill.ts`: `alvDrillHref` returns `` `/kirjanpito/alv?period=${encodeURIComponent(period)}` ``.

`src/lib/chat-honesty.ts`: in `KNOWN_SCREENS` replace `"/alv-raportti"` with `"/kirjanpito/alv"`; in `SOURCE_RULES` replace `{ prefix: "/alv-raportti", label: "ALV-raportti" }` with `{ prefix: "/kirjanpito/alv", label: "ALV-raportti" }`. In `src/lib/chat-honesty.test.ts` replace every `/alv-raportti?period=2026-09` with `/kirjanpito/alv?period=2026-09` (5 occurrences, lines 51, 61, 63, 100, 102; verify with `grep -c "/alv-raportti" src/lib/chat-honesty.test.ts` → `0`).

`src/app/dashboard/DashboardClient.tsx:406`: `href="/pankki"` → `href="/kirjanpito"` (its label changes in Step 7b).

`src/app/bank/callback/page.tsx`: line 61 `router.replace("/pankki")` → `router.replace("/kirjanpito/pankkitilit")`; lines 88-93 `href="/pankki"` → `href="/kirjanpito/pankkitilit"` and the two labels `Jatka asetuksiin` / `Takaisin asetuksiin` → `Jatka pankkitileihin` / `Takaisin pankkitileihin`.

- [ ] **Step 7b: Keep the shell compiling until Task 3**

`src/components/AppShell.tsx` still imports the removed helpers. Bridge it with the smallest change (Task 3 rewrites these parts):
- In the `@/lib/navigation` import, replace `moreRoots, primaryRoots, rootNav,` with `avatarRoot, tabRoots,`.
- `rootNav().map(` → `tabRoots().map(` (sidebar), `primaryRoots().map(` → `tabRoots().map(` (tab bar), both `moreRoots()` calls → `[avatarRoot()]` (the Muut sheet and `moreActive`). The Muut sheet temporarily holds only Asetukset.
- `const title = matchNav(pathname)?.label ?? "Etusivu";` → `?? "Koti"`.

Also update `src/app/dashboard/DashboardClient.tsx:412`: the quick-action text `Pankki` → `Kirjanpito` (the `href` change is in Step 7).

- [ ] **Step 8: Run tests, typecheck, lint**

Run: `npx vitest run src/lib/navigation.test.ts src/lib/chat-honesty.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm run lint && npm test`
Expected: typecheck and lint clean; unit tests 5 failed (the known Windows-only three files) and the rest passed. Any other failure is a regression: fix before committing.
Run: `grep -rnE "\"/(alv-raportti|ostolaskut|asetukset/kirjanpito|asetukset/pankkiyhteys|pankki/tilit)\b" src --include=*.ts --include=*.tsx | grep -v "\.test\."`
Expected: no output (only `next.config.ts` and `proxy.ts` may still mention them; `proxy.ts` is Task 2).

- [ ] **Step 9: Commit**

```bash
git add -A src next.config.ts
git commit -m "feat(nav): four tab roots, Kirjanpito hub, moved routes with redirects" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01Dt441ofXM5z9eZZdckoQC9"
```

---

### Task 2: Deny-by-default page protection

**Files:**
- Modify: `src/proxy.ts:12-26` (prefix list), `:62-79` (page branch), `:105-124` (matcher)
- Create: `src/proxy.test.ts`

**Interfaces:**
- Produces: `export function isPublicPage(pathname: string): boolean;` and `export const PUBLIC_PAGES: readonly string[];` from `src/proxy.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/proxy.test.ts`. It walks every `page.tsx` like `navigation.test.ts` does, so a new page cannot be left unprotected:

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { PUBLIC_PAGES, isPublicPage } from "./proxy";

const APP_DIR = path.resolve(__dirname, "app");

function pagesIn(dir: string, prefix: string): string[] {
  const routes: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      const segment = name.startsWith("[") && name.endsWith("]") ? "x" : name;
      routes.push(...pagesIn(full, `${prefix}/${segment}`));
      continue;
    }
    if (name === "page.tsx") routes.push(prefix || "/");
  }
  return routes;
}

describe("page protection", () => {
  it("lists only signed-out screens as public", () => {
    expect([...PUBLIC_PAGES].sort()).toEqual(
      ["/login", "/palauta-salasana", "/unohtunut-salasana", "/vahvista-sahkoposti"].sort()
    );
  });

  it("protects every other page, including ones added later", () => {
    const exposed = pagesIn(APP_DIR, "").filter((route) => isPublicPage(route) && !PUBLIC_PAGES.includes(route));
    expect(exposed).toEqual([]);
    expect(isPublicPage("/tyot")).toBe(false);
    expect(isPublicPage("/kirjanpito/alv")).toBe(false);
    expect(isPublicPage("/bank/callback")).toBe(false);
    expect(isPublicPage("/")).toBe(false);
  });

  it("does not treat a prefix lookalike as public", () => {
    expect(isPublicPage("/login-admin")).toBe(false);
    expect(isPublicPage("/login/extra")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/proxy.test.ts`
Expected: FAIL, `PUBLIC_PAGES` / `isPublicPage` not exported.

- [ ] **Step 3: Invert the protection**

In `src/proxy.ts`, replace the `protectedPrefixes` array with:

```ts
/** Signed-out screens. Every other page requires a session. */
export const PUBLIC_PAGES: readonly string[] = [
  "/login",
  "/unohtunut-salasana",
  "/palauta-salasana",
  "/vahvista-sahkoposti",
];

export function isPublicPage(pathname: string): boolean {
  return PUBLIC_PAGES.includes(pathname);
}
```

Replace the page branch (from `// --- Protected page routes ---` to the line before `const response = NextResponse.next();`) with:

```ts
  // --- Page routes: protected unless explicitly public ---
  const isProtected = !isPublicPage(pathname);
  const isAuthenticated = await authenticated(request);
  if (isProtected && !isAuthenticated) {
    // Deep-link continue-after-login: remember where the user was headed.
    const target = `${pathname}${request.nextUrl.search}`;
    const search = target === "/" ? "" : `?next=${encodeURIComponent(target)}`;
    return redirectForRequest(request, "/login", search);
  }
  if (pathname === "/login" && isAuthenticated) {
    return redirectForRequest(request, "/dashboard");
  }
```

Replace `export const config` with a negative matcher (syntax per `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`, "negative matching"):

```ts
export const config = {
  matcher: [
    // Everything except Next internals and files served from public/.
    "/((?!_next/static|_next/image|favicon\\.ico|manifest\\.json|offline\\.html|index\\.html|icons/|.*\\.(?:png|svg|jpg|jpeg|webp|ico|txt|webmanifest)$).*)",
  ],
};
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify against the running dev server**

Start (or reuse) the dev server on port 3200. Then, signed out:

```bash
for p in /tyot /kirjanpito /kirjanpito/alv /dashboard /; do curl -s -o /dev/null -w "$p %{http_code} %{redirect_url}\n" "http://127.0.0.1:3200$p"; done
for p in /login /unohtunut-salasana /manifest.json /icons/icon-192.png; do curl -s -o /dev/null -w "$p %{http_code}\n" "http://127.0.0.1:3200$p"; done
```

Expected: the first five answer `307` with a `/login` redirect (`/tyot` now included); the second four answer `200`.

- [ ] **Step 6: Full check and commit**

Run: `npm run typecheck && npm test` (same baseline as Task 1).

```bash
git add src/proxy.ts src/proxy.test.ts
git commit -m "fix(security): protect every page unless it is a signed-out screen" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01Dt441ofXM5z9eZZdckoQC9"
```

---

### Task 3: Shell: tab bar with "+", avatar sheet with Asetukset, labelled back

**Files:**
- Modify: `src/components/AppShell.tsx` (imports `:37-44`, state `:176`, back `:212-214`, derived `:466-474`, sidebar `:478-504`, header left slot `:510-532`, tab bar + sheets `:590-744`)
- Modify: `src/lib/nav-direction.ts:77-90` (`performInAppBack` fallback parameter)
- Modify: `src/lib/nav-direction.test.ts` (add one test)
- Modify: `src/app/globals.css:118-123` (`.app-header-row`)

**Interfaces:**
- Consumes: `tabRoots`, `avatarRoot`, `backTarget`, `shellShowsBack`, `matchNav`, `rootIsActive` (Task 1).
- Produces: `performInAppBack(pathname, router, fallback?: string): void` (fallback defaults to `fallbackBackPath(pathname)`).

- [ ] **Step 1: Failing test for the back fallback**

Append to `src/lib/nav-direction.test.ts` (it already imports from `./nav-direction`; add `performInAppBack` and `resetNavigationForTests` to that import if missing):

```ts
describe("performInAppBack fallback", () => {
  it("replaces to the given parent when there is no in-app history", () => {
    resetNavigationForTests();
    const calls: string[] = [];
    performInAppBack("/asiakkaat", { back: () => calls.push("back"), replace: (href) => calls.push(href) }, "/laskut");
    expect(calls).toEqual(["/laskut"]);
  });

  it("still uses history when there is a previous in-app screen", () => {
    resetNavigationForTests();
    recordRoute("/laskut", "tab");
    recordRoute("/asiakkaat", "forward");
    const calls: string[] = [];
    performInAppBack("/asiakkaat", { back: () => calls.push("back"), replace: (href) => calls.push(href) }, "/laskut");
    expect(calls).toEqual(["back"]);
  });
});
```

Run: `npx vitest run src/lib/nav-direction.test.ts`
Expected: the first new test FAILS (it replaces to `/dashboard`, the segment fallback).

- [ ] **Step 2: Add the fallback parameter**

In `src/lib/nav-direction.ts` change `performInAppBack` to:

```ts
export function performInAppBack(
  pathname: string,
  router: { back: () => void; replace: (href: string) => void },
  fallback: string = fallbackBackPath(pathname)
): void {
  if (inAppPrevious(pathname)) {
    markHistoryBack();
    router.back();
    return;
  }
  armNavigation(fallback, "back");
  router.replace(fallback);
}
```

Run: `npx vitest run src/lib/nav-direction.test.ts` → PASS.

- [ ] **Step 3: Header grid for a labelled back**

In `src/app/globals.css` change `.app-header-row`'s `grid-template-columns` to `minmax(2.75rem, 8rem) minmax(0, 1fr) auto;`.

- [ ] **Step 4: Rewire AppShell**

1. Imports: replace `moreRoots, primaryRoots, rootNav,` with `avatarRoot, backTarget, tabRoots,` in the `@/lib/navigation` import. Add `import Link from "next/link";`.
2. Rename the `moreOpenOn` state to `addOpenOn` (`const [addOpenOn, setAddOpenOn] = useState<string | null>(null);`) and update every use.
3. `const title = matchNav(pathname)?.label ?? "Koti";`
4. After `const canGoBack = shellShowsBack(pathname);` add `const back = backTarget(pathname);`.
5. `goBack` becomes: `requestLeave(() => performInAppBack(pathname, router, back?.href));`
6. Replace the `moreOpen` / `moreActive` lines with `const addOpen = addOpenOn === pathname;` and in `goToRoot` replace `setMoreOpenOn(null)` with `setAddOpenOn(null); setProfileOpenOn(null);`.
7. Sidebar: map `tabRoots()` instead of `rootNav()`. Directly after the `<p>LashKirja</p>` add a full-width "Lisää" button:
   ```tsx
   <div className="px-2 pb-3">
     <button
       type="button"
       onClick={() => setAddOpenOn(pathname)}
       aria-haspopup="dialog"
       className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-charcoal text-sm font-semibold text-white active-press"
     >
       <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
         <path strokeLinecap="round" d="M12 5v14M5 12h14" />
       </svg>
       Lisää
     </button>
   </div>
   ```
   After the `</nav>` inside the sidebar, add the Asetukset footer:
   ```tsx
   <div className="mt-auto px-2 pb-4">
     <button
       type="button"
       onClick={() => goToRoot(avatarRoot().path)}
       aria-current={rootIsActive(pathname, "asetukset") ? "page" : undefined}
       className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium text-charcoal active-press"
     >
       <RootIcon id="asetukset" active={rootIsActive(pathname, "asetukset")} className="h-5 w-5 text-warm-gray" />
       Asetukset
     </button>
   </div>
   ```
8. Header left slot: replace the `<div className="flex h-11 w-11 items-center justify-center">…</div>` wrapper and its back button with:
   ```tsx
   <div className="flex h-11 min-w-11 items-center">
     {canGoBack && (
       <button
         type="button"
         onClick={goBack}
         aria-label="Takaisin"
         className="flex h-11 max-w-full items-center gap-0.5 pl-1 pr-2 text-accent-dark active-press"
       >
         <svg className="h-6 w-6 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
           <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
         </svg>
         {back && <span className="truncate text-sm font-medium">{back.label}</span>}
       </button>
     )}
   </div>
   ```
   `aria-label` stays `Takaisin` so existing tests and screen readers keep working.
9. Tab bar: replace the body of `<div className="mx-auto flex h-[var(--app-tab-height)] max-w-lg items-stretch">` with the two first tab roots, the "+" button, then the last two:
   ```tsx
   {tabRoots().slice(0, 2).map((item) => renderTab(item))}
   <div className="flex min-w-0 flex-1 items-center justify-center">
     <button
       type="button"
       onClick={() => {
         void hapticSelection();
         setAddOpenOn(pathname);
       }}
       aria-label="Lisää"
       aria-haspopup="dialog"
       aria-expanded={addOpen}
       className="flex h-12 w-12 items-center justify-center rounded-full bg-charcoal text-white active-press"
     >
       <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
         <path strokeLinecap="round" d="M12 5v14M5 12h14" />
       </svg>
     </button>
   </div>
   {tabRoots().slice(2).map((item) => renderTab(item))}
   ```
   Define `renderTab` inside the component, above `return`, by moving the existing per-item `<button key={item.id} …>…</button>` JSX from the old `primaryRoots().map(...)` into `function renderTab(item: NavEntry) { const active = rootIsActive(pathname, item.id); return (…); }` (import `type NavEntry` from `@/lib/navigation`). Delete the old "Muut" button.
10. Replace the "Muut" `<BottomSheet …>` with the "Lisää" sheet. Links are the phase-1 destinations; phase 6 replaces the behaviour:
    ```tsx
    <BottomSheet
      isOpen={addOpen}
      onClose={() => setAddOpenOn(null)}
      title="Lisää"
      labelledBy="add-sheet-title"
      heightClass="max-h-[70dvh]"
    >
      <div className="space-y-2 px-3 py-2 sheet-safe-bottom">
        <Link
          href="/kuitit/uusi"
          onClick={() => setAddOpenOn(null)}
          className="flex items-center gap-3 rounded-2xl bg-charcoal px-4 py-4 text-white active-press"
        >
          <span className="text-base font-semibold">Kuvaa kuitti</span>
        </Link>
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm divide-y divide-warm-gray-light/25">
          {[
            { href: "/pankki/tapahtumat", label: "Tuo tiliote", hint: "CSV, XLSX, camt tai PDF" },
            { href: "/laskut/uusi", label: "Uusi myyntilasku" },
            { href: "/asetukset/sahkoposti", label: "Hae sähköpostista" },
          ].map((row) => (
            <Link
              key={row.href}
              href={row.href}
              onClick={() => setAddOpenOn(null)}
              className="flex flex-col px-4 py-3.5 active:bg-blush/30 touch-target"
            >
              <span className="text-sm font-medium text-charcoal">{row.label}</span>
              {row.hint && <span className="mt-0.5 text-xs text-warm-gray">{row.hint}</span>}
            </Link>
          ))}
        </div>
      </div>
    </BottomSheet>
    ```
11. Avatar sheet: as the first child of its `<div className="px-3 py-2 sheet-safe-bottom space-y-1">`, add:
    ```tsx
    <button
      type="button"
      onClick={() => goToRoot(avatarRoot().path)}
      className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl text-left active:bg-blush/40 touch-target"
    >
      <RootIcon id="asetukset" active={false} className="h-4 w-4 text-warm-gray" />
      <span className="text-sm font-medium text-charcoal">Asetukset</span>
    </button>
    ```
    and change the avatar button's `aria-label` to `Profiili, asetukset ja uloskirjautuminen`.
12. `RootIcon` for the new `kirjanpito` path already exists (`id === "kirjanpito"`). The `pankki` and `kuitit` branches become unused by the tab bar; leave them (the function is keyed by id and is harmless).

- [ ] **Step 5: Typecheck, lint, unit tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: same baseline as Task 1.

- [ ] **Step 6: Manual check in the running app (phone and desktop)**

With the dev server on 3200, sign in as `demo@lashkirja.fi` / `demo123` and check, at 390×844 and at 1440×900:
- Tab bar reads Koti, Myynti, (+), Kirjanpito, Raportit; no "Muut".
- "+" opens the Lisää sheet; each row lands on its page and closes the sheet.
- Avatar sheet shows Asetukset above Kirjaudu ulos; Asetukset opens `/asetukset`.
- `/kirjanpito/alv` header shows "‹ Kirjanpito"; tapping it returns to `/kirjanpito`. Opening `/asiakkaat` directly by URL and tapping back lands on `/laskut`.
- Desktop sidebar: Lisää button on top, 4 roots, Asetukset at the bottom.

Take a screenshot of each for the review (store outside the repo).

- [ ] **Step 7: Commit**

```bash
git add src/components/AppShell.tsx src/lib/nav-direction.ts src/lib/nav-direction.test.ts src/app/globals.css
git commit -m "feat(shell): tab bar with Lisää sheet, Asetukset behind the avatar, labelled back" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01Dt441ofXM5z9eZZdckoQC9"
```

---

### Task 4: Remove the remaining duplicate paths

**Files:**
- Modify: `src/app/laskut/page.tsx:17,194` (chips out, two rows in)
- Modify: `src/app/asiakkaat/page.tsx:22,256`, `src/app/toistuvat/page.tsx:14,280`, `src/app/kirjanpito/ostolaskut/page.tsx:17,287`
- Delete: `src/components/WorkspaceLinks.tsx`
- Modify: `src/app/asetukset/page.tsx:84-88,108-112` (drop the two moved rows)
- Modify: `src/app/kirjanpito/alv/page.tsx:155` (settings mention becomes a link)

**Interfaces:**
- Consumes: `SettingsGroup`, `SettingsRow` from `@/components/SettingsList` (existing).

- [ ] **Step 1: Myynti chips become rows at the bottom of /laskut**

In `src/app/laskut/page.tsx` delete the `WorkspaceLinks` import and the `<WorkspaceLinks … />` element (line 194). Add `import { SettingsGroup, SettingsRow } from "@/components/SettingsList";` and, as the last child of the page's outermost container, add:

```tsx
<SettingsGroup label="Myynnin rekisterit">
  <SettingsRow href="/asiakkaat" label="Asiakkaat" hint="Y-tunnus, maksuaika ja avoin saldo" />
  <SettingsRow href="/toistuvat" label="Toistuvat laskut" hint="Sama lasku kuukausittain tai vuosittain" />
</SettingsGroup>
```

In `asiakkaat/page.tsx`, `toistuvat/page.tsx`, `kirjanpito/ostolaskut/page.tsx` delete the `WorkspaceLinks` import and element. Then `git rm src/components/WorkspaceLinks.tsx`.

- [ ] **Step 2: Settings keep only settings**

In `src/app/asetukset/page.tsx` delete the `SettingsRow` with `href="/asetukset/kirjanpito"` and the one with `href="/asetukset/pankkiyhteys"`. The "Integraatiot" group keeps only Sähköpostien tuonti.

- [ ] **Step 3: ALV page links to where the rate is set**

In `src/app/kirjanpito/alv/page.tsx` around line 155, the text `(Asetukset)` is plain text. Replace it with `<Link href="/asetukset/yritys" className="underline">Asetukset</Link>` (add `import Link from "next/link";` if missing). Read the surrounding sentence first and keep its wording otherwise.

- [ ] **Step 4: Verify nothing links to a duplicate path**

Run: `grep -rn "WorkspaceLinks\|INVOICE_LINKS\|asetukset/kirjanpito\|asetukset/pankkiyhteys" src --include=*.ts --include=*.tsx`
Expected: no output.
Run: `npm run typecheck && npm run lint && npm test` (baseline).

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(nav): one path per function in Myynti and Asetukset" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01Dt441ofXM5z9eZZdckoQC9"
```

---

### Task 5: E2E and navigation docs

**Files:**
- Modify: `tests/e2e/app.spec.ts:30-47` (tab bar test)
- Modify: `package.json` `test:e2e:ci` grep (only if a renamed test title is in it)
- Modify: `docs/navigation.md` (rewrite to the new rules)

- [ ] **Step 1: Update the tab-bar e2e test**

Replace the body of `test("login lands on the dashboard and the tab bar navigates", …)` after the two `Tulot`/heading expectations with:

```ts
  const nav = page.getByRole("navigation", { name: "Päävalikko" });
  await expect(nav.getByRole("button", { name: "Muut" })).toHaveCount(0);

  await nav.getByRole("button", { name: "Myynti" }).click();
  await expect(page).toHaveURL(/\/laskut$/);

  await nav.getByRole("button", { name: "Kirjanpito" }).click();
  await expect(page).toHaveURL(/\/kirjanpito$/);
  await page.getByRole("link", { name: /ALV-ilmoitus/ }).click();
  await expect(page).toHaveURL(/\/kirjanpito\/alv$/);
  await page.getByRole("button", { name: "Takaisin" }).click();
  await expect(page).toHaveURL(/\/kirjanpito$/);

  await nav.getByRole("button", { name: "Lisää" }).click();
  await expect(page.getByRole("link", { name: "Kuvaa kuitti" })).toBeVisible();
  await page.keyboard.press("Escape");

  await nav.getByRole("button", { name: "Raportit" }).click();
  await expect(page).toHaveURL(/\/raportit$/);

  await page.getByRole("button", { name: /Profiili, asetukset/ }).click();
  await page.getByRole("button", { name: "Asetukset" }).click();
  await expect(page).toHaveURL(/\/asetukset$/);
```

The title is unchanged, so the `test:e2e:ci` grep still matches it. The bank-account tests use `/pankkitilit`, which now redirects to `/kirjanpito/pankkitilit`; leave them.

- [ ] **Step 2: Run the mobile CI subset**

Run: `npm run build && npm run test:e2e:ci`
Expected: all selected tests pass. If Playwright's bundled browser is missing, run with the installed Chrome: `npx playwright test --project=mobile-chromium` after setting `channel: "chrome"` locally only (do not commit that change).

- [ ] **Step 3: Rewrite `docs/navigation.md`**

```markdown
# Navigointi

Yksi rekisteri: `app/src/lib/navigation.ts`. Välilehtipalkki ja sivupalkki piirtävät vain `placement: "tab"` -juuret. Asetukset on `placement: "avatar"` ja aukeaa profiilikuvasta.

Juuret: Koti, Myynti, Kirjanpito, Raportit. Mobiilissa Myynnin ja Kirjanpidon välissä on Lisää (+).

## Säännöt

1. Välilehtijuuria on tasan neljä, avatar-juuria yksi (Asetukset). Uusi ominaisuus ei saa uutta juurta.
2. Moduulissa on enintään yksi toinen navigointitaso; kolmitasoinen valikko on kielletty.
3. Detail-, luonti- ja muokkausnäkymät eivät ole päävalikossa.
4. Samalla toiminnolla ei ole kahta pysyvää valikkopolkua.
5. Juuren alapuolisella sivulla on yksi Takaisin: kuoren painike, jonka teksti on rekisterin vanhemman nimi. Ei murupolkuja, ei sivun omaa Takaisin-painiketta.
6. Suodattimet eivät vaihda sivua. Sivulla on enintään yksi suodatinrivi.
7. Luonti alkaa Lisää-valikosta. Myynnin "Uusi lasku" on saman reitin pikavalinta.
8. Uusi reitti vaatii `kind`-arvon rekisterissä; kaikki sivut ovat suojattuja, ellei niitä ole lueteltu `proxy.ts`:n `PUBLIC_PAGES`-listassa.

`navigationViolations()`, `navigation.test.ts` ja `proxy.test.ts` kaatavat testit, jos rekisteri tai suojaus rikkoo näitä.
```

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/app.spec.ts docs/navigation.md package.json
git commit -m "test(e2e): cover the new tab bar, Lisää sheet and labelled back; document the rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01Dt441ofXM5z9eZZdckoQC9"
```
