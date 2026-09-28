/**
 * Detail pages read `?id=` instead of a dynamic `[id]` path segment, so both
 * the web and the static-export mobile build can serve them from one static
 * HTML file. This module is the single place that knows the mapping between
 * a detail kind and its path, in both directions.
 */

export type DetailKind = "invoice" | "receipt" | "customer" | "statement";

export const DETAIL_ROUTES: Record<DetailKind, string> = {
  invoice: "/laskut/lasku",
  receipt: "/kuitit/kuitti",
  customer: "/asiakkaat/asiakas",
  statement: "/pankki/tapahtumat/tiliote",
};

/**
 * `detailHref("invoice", "abc")` -> `/laskut/lasku?id=abc`. Extra params are
 * appended after `id`, in the order they appear in `extra`.
 */
export function detailHref(kind: DetailKind, id: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  params.set("id", id);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (key === "id") continue;
      params.set(key, value);
    }
  }
  return `${DETAIL_ROUTES[kind]}?${params.toString()}`;
}

type LegacyEntry = { prefix: string; kind: DetailKind; ownPaths: Set<string> };

// One entry per parent that used to hold a dynamic `[id]` route. `ownPaths`
// lists that parent's static sibling folders plus the new detail path's own
// last segment - none of those are a legacy id.
const LEGACY_ENTRIES: LegacyEntry[] = [
  { prefix: "/laskut/", kind: "invoice", ownPaths: new Set(["uusi", "lasku"]) },
  { prefix: "/kuitit/", kind: "receipt", ownPaths: new Set(["uusi", "kuitti"]) },
  { prefix: "/asiakkaat/", kind: "customer", ownPaths: new Set(["asiakas"]) },
  { prefix: "/pankki/tapahtumat/", kind: "statement", ownPaths: new Set(["tiliote"]) },
];

/**
 * `normalizeLegacyDetailPath("/laskut/abc?x=1")` -> `/laskut/lasku?id=abc&x=1`.
 * Returns `null` for anything that is not a legacy detail path: a static
 * sibling (e.g. `/laskut/uusi`), a deeper path, or a new-format path already.
 */
export function normalizeLegacyDetailPath(href: string): string | null {
  const queryIndex = href.indexOf("?");
  const path = queryIndex === -1 ? href : href.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : href.slice(queryIndex + 1);

  for (const entry of LEGACY_ENTRIES) {
    if (!path.startsWith(entry.prefix)) continue;
    const rest = path.slice(entry.prefix.length);
    if (!rest || rest.includes("/") || entry.ownPaths.has(rest)) return null;

    const merged = new URLSearchParams();
    merged.set("id", rest);
    for (const [key, value] of new URLSearchParams(query)) {
      if (key === "id") continue;
      merged.set(key, value);
    }
    return `${DETAIL_ROUTES[entry.kind]}?${merged.toString()}`;
  }
  return null;
}
