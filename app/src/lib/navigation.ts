/**
 * Single navigation registry. The tab bar and sidebar render tab roots;
 * Asetukset is the avatar root. New product features are workspace, detail,
 * or settings entries, never a new root.
 */

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
  if (!parent || parent.path.includes(":")) return null;
  return { label: parent.label, href: parent.path };
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
