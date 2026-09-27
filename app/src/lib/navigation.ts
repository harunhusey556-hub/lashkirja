/**
 * Single navigation registry. The desktop sidebar and the mobile tab bar
 * render `kind === "root"` only. New product features are workspace, detail,
 * or settings entries — never a new root.
 */

export type NavKind = "root" | "workspace" | "detail" | "settings";

export type NavEntry = {
  id: string;
  kind: NavKind;
  label: string;
  /** Canonical path. A `:param` segment matches one URL piece. */
  path: string;
  parent?: string;
  /** Roots only. Primary roots are the mobile tab bar; the rest sit in Muut. */
  mobile?: "primary" | "more";
};

export const NAV: readonly NavEntry[] = [
  { id: "etusivu", kind: "root", label: "Etusivu", path: "/dashboard", mobile: "primary" },
  { id: "pankki", kind: "root", label: "Pankki", path: "/pankki", mobile: "primary" },
  { id: "kuitit", kind: "root", label: "Kuitit", path: "/kuitit", mobile: "primary" },
  { id: "myynti", kind: "root", label: "Myynti", path: "/laskut", mobile: "primary" },
  { id: "kirjanpito", kind: "root", label: "Kirjanpito", path: "/alv-raportti", mobile: "more" },
  { id: "raportit", kind: "root", label: "Raportit", path: "/raportit", mobile: "more" },
  { id: "asetukset", kind: "root", label: "Asetukset", path: "/asetukset", mobile: "more" },

  { id: "pankki-tapahtumat", kind: "workspace", label: "Tapahtumat", path: "/pankki/tapahtumat", parent: "pankki" },
  { id: "pankki-tilit", kind: "workspace", label: "Tilit", path: "/pankki/tilit", parent: "pankki" },
  { id: "pankki-taydennys", kind: "workspace", label: "Täsmäytys", path: "/pankki/taydennys", parent: "pankki" },
  {
    id: "pankki-tapahtuma",
    kind: "detail",
    label: "Tiliote",
    path: "/pankki/tapahtumat/:id",
    parent: "pankki-tapahtumat",
  },

  { id: "kuitit-uusi", kind: "detail", label: "Uusi kuitti", path: "/kuitit/uusi", parent: "kuitit" },
  { id: "kuitti", kind: "detail", label: "Kuitti", path: "/kuitit/:id", parent: "kuitit" },
  { id: "tyot", kind: "workspace", label: "Työt", path: "/tyot", parent: "kuitit" },

  { id: "ostolaskut", kind: "workspace", label: "Ostolaskut", path: "/ostolaskut", parent: "myynti" },
  { id: "asiakkaat", kind: "workspace", label: "Asiakkaat", path: "/asiakkaat", parent: "myynti" },
  { id: "toistuvat", kind: "workspace", label: "Toistuvat", path: "/toistuvat", parent: "myynti" },
  { id: "lasku-uusi", kind: "detail", label: "Uusi lasku", path: "/laskut/uusi", parent: "myynti" },
  { id: "lasku", kind: "detail", label: "Lasku", path: "/laskut/:id", parent: "myynti" },
  { id: "asiakas", kind: "detail", label: "Asiakas", path: "/asiakkaat/:id", parent: "asiakkaat" },

  { id: "asetukset-profiili", kind: "settings", label: "Profiili", path: "/asetukset/profiili", parent: "asetukset" },
  { id: "asetukset-yritys", kind: "settings", label: "Yritysmuoto & ALV", path: "/asetukset/yritys", parent: "asetukset" },
  { id: "asetukset-laskutus", kind: "settings", label: "Laskuttajan tiedot", path: "/asetukset/laskutus", parent: "asetukset" },
  { id: "asetukset-kirjanpito", kind: "settings", label: "Kirjanpidon lukitus", path: "/asetukset/kirjanpito", parent: "asetukset" },
  { id: "asetukset-tili", kind: "settings", label: "Tili", path: "/asetukset/tili", parent: "asetukset" },
  { id: "asetukset-salasana", kind: "settings", label: "Vaihda salasana", path: "/asetukset/tili/salasana", parent: "asetukset-tili" },
  { id: "asetukset-laitteet", kind: "settings", label: "Laitteet", path: "/asetukset/tili/laitteet", parent: "asetukset-tili" },
  { id: "asetukset-turvallisuus", kind: "settings", label: "Turvallisuus", path: "/asetukset/turvallisuus", parent: "asetukset" },
  { id: "asetukset-lukitus", kind: "settings", label: "Näytön lukitus", path: "/asetukset/turvallisuus/lukitus", parent: "asetukset-turvallisuus" },
  { id: "asetukset-biometria", kind: "settings", label: "Face ID", path: "/asetukset/turvallisuus/biometria", parent: "asetukset-turvallisuus" },
  { id: "asetukset-tietosuoja", kind: "settings", label: "Tietosuoja", path: "/asetukset/tietosuoja", parent: "asetukset" },
  { id: "asetukset-pankkiyhteys", kind: "settings", label: "Pankkiyhteys", path: "/asetukset/pankkiyhteys", parent: "asetukset" },
  { id: "asetukset-sahkoposti", kind: "settings", label: "Sähköpostien tuonti", path: "/asetukset/sahkoposti", parent: "asetukset" },
  { id: "asetukset-ohje", kind: "settings", label: "Ohje ja tuki", path: "/asetukset/ohje", parent: "asetukset" },
];

/** Roots that may appear in Muut. Anything else there is a junk drawer. */
const MORE_ROOT_IDS = ["kirjanpito", "raportit", "asetukset"] as const;

const BANK_TAB_LABELS: Record<string, string> = {
  pankki: "Yhteenveto",
  "pankki-tapahtumat": "Tapahtumat",
  "pankki-tilit": "Tilit",
  "pankki-taydennys": "Täsmäytys",
};

export function rootNav(entries: readonly NavEntry[] = NAV): NavEntry[] {
  return entries.filter((entry) => entry.kind === "root");
}

export function primaryRoots(entries: readonly NavEntry[] = NAV): NavEntry[] {
  return rootNav(entries).filter((entry) => entry.mobile === "primary");
}

export function moreRoots(entries: readonly NavEntry[] = NAV): NavEntry[] {
  return rootNav(entries).filter((entry) => entry.mobile === "more");
}

export function childrenOf(parentId: string, entries: readonly NavEntry[] = NAV): NavEntry[] {
  return entries.filter((entry) => entry.parent === parentId);
}

/**
 * Bank workspace tabs. Yhteenveto reuses the Pankki root path — it is the
 * module home, not a second registry row.
 */
export function bankTabs(entries: readonly NavEntry[] = NAV): Array<{ id: string; href: string; label: string }> {
  const root = entries.find((entry) => entry.id === "pankki");
  const tabs = [
    ...(root ? [{ id: root.id, href: root.path, label: BANK_TAB_LABELS.pankki }] : []),
    ...childrenOf("pankki", entries)
      .filter((entry) => entry.kind === "workspace")
      .map((entry) => ({
        id: entry.id,
        href: entry.path,
        label: BANK_TAB_LABELS[entry.id] ?? entry.label,
      })),
  ];
  return tabs;
}

export function activeBankTab(pathname: string, entries: readonly NavEntry[] = NAV): string {
  const tabs = [...bankTabs(entries)].sort((a, b) => b.href.length - a.href.length);
  return tabs.find((tab) => pathname === tab.href || pathname.startsWith(`${tab.href}/`))?.href ?? "/pankki";
}

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function routeMatches(pattern: string, pathname: string): boolean {
  const expected = segments(pattern);
  const actual = segments(pathname.split("?")[0] ?? pathname);
  if (expected.length !== actual.length) return false;
  return expected.every((part, index) => part.startsWith(":") || part === actual[index]);
}

export function matchNav(pathname: string, entries: readonly NavEntry[] = NAV): NavEntry | null {
  const path = pathname.split("?")[0] || "/";
  let best: NavEntry | null = null;
  let bestScore = -1;
  for (const entry of entries) {
    if (!routeMatches(entry.path, path)) continue;
    const score = segments(entry.path).length;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

function ancestorChain(entry: NavEntry, byId: Map<string, NavEntry>): NavEntry[] {
  const chain: NavEntry[] = [];
  const seen = new Set<string>();
  let cursor: NavEntry | undefined = entry;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
  }
  return chain;
}

export function rootIsActive(pathname: string, rootId: string, entries: readonly NavEntry[] = NAV): boolean {
  const match = matchNav(pathname, entries);
  if (!match) return false;
  if (match.id === rootId) return true;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return ancestorChain(match, byId).some((entry) => entry.id === rootId);
}

/**
 * Shell back is the single back for settings and for modules that do not
 * render PageHeader yet. Bank workspace and bank detail own their back.
 */
export function shellShowsBack(pathname: string, entries: readonly NavEntry[] = NAV): boolean {
  const match = matchNav(pathname, entries);
  if (!match) return false;
  if (match.kind === "root" || match.kind === "workspace") return false;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const underBank = ancestorChain(match, byId).some((entry) => entry.id === "pankki");
  if (underBank) return false;
  return match.kind === "detail" || match.kind === "settings";
}

const STATEMENT_QUERY_KEYS = ["month", "account", "q"] as const;

/** List → detail → back keeps the Tapahtumat toolbar in the query string. */
export function statementListHref(search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const keep = new URLSearchParams();
  for (const key of STATEMENT_QUERY_KEYS) {
    const value = params.get(key)?.trim();
    if (value) keep.set(key, value);
  }
  const query = keep.toString();
  return query ? `/pankki/tapahtumat?${query}` : "/pankki/tapahtumat";
}

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

    if (entry.kind !== "root" && entry.mobile) {
      errors.push(`${entry.id}: workspace, detail, and settings stay out of root nav and Muut`);
    }
    if ((entry.kind === "detail" || entry.kind === "workspace" || entry.kind === "settings") && !entry.parent) {
      errors.push(`${entry.id}: ${entry.kind} without parent`);
    }
  }

  const roots = rootNav(entries);
  if (roots.length < 6 || roots.length > 7) {
    errors.push(`sidebar has ${roots.length} roots; keep 6–7`);
  }
  for (const root of roots) {
    if (root.mobile !== "primary" && root.mobile !== "more") {
      errors.push(`${root.id}: root needs a mobile slot`);
    }
  }

  const more = moreRoots(entries);
  const allowedMore = new Set<string>(MORE_ROOT_IDS);
  if (more.length !== allowedMore.size || more.some((entry) => !allowedMore.has(entry.id))) {
    errors.push("Muut may contain only Kirjanpito, Raportit, and Asetukset");
  }
  for (const entry of entries) {
    if (entry.kind !== "root" && more.some((root) => root.id === entry.id)) {
      errors.push(`${entry.id}: Muut is not a feature drawer`);
    }
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
    const workspaces = chain.filter((item) => item.kind === "workspace");
    if (workspaces.length > 1) errors.push(`${entry.id}: 3-level menu`);
    if (entry.kind === "settings") {
      const rooted = chain.some((item) => item.id === "asetukset");
      if (!rooted) errors.push(`${entry.id}: settings must live under Asetukset`);
      if (chain.some((item) => item.kind === "workspace")) {
        errors.push(`${entry.id}: settings mixed into a workspace menu`);
      }
    }
  }

  const bank = bankTabs(entries);
  const bankLabels = bank.map((tab) => tab.label).join("|");
  if (bankLabels !== "Yhteenveto|Tapahtumat|Tilit|Täsmäytys") {
    errors.push(`bank tabs must stay Yhteenveto|Tapahtumat|Tilit|Täsmäytys (got ${bankLabels})`);
  }

  return errors;
}
