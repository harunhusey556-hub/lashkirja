/**
 * Keyset paging for the document lists (Kuitit, Myynti, Ostolaskut), the same contract W18 gave the
 * bank feed: `?cursor=` (empty for the first page) and `?limit=` (1-200, default 50), newest first by
 * a date column (rows without a date last), then id. A row stored while the owner scrolls never
 * shifts a page or repeats a row, which offset paging over a 1 500-row list did.
 */
export const LIST_PAGE_SIZE = 50;
export const LIST_PAGE_MAX = 200;

/** A cursor or limit the server did not hand out; the route answers 400. */
export class ListCursorError extends Error {}

type ListCursor = { d: string | null; id: string };

export function encodeListCursor(date: Date | null, id: string): string {
  const cursor: ListCursor = { d: date ? date.toISOString() : null, id };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeListCursor(raw: string): ListCursor {
  let value: Partial<ListCursor>;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<ListCursor>;
  } catch {
    throw new ListCursorError("Virheellinen sivutuskursori");
  }
  const dateOk = value.d === null || (typeof value.d === "string" && !Number.isNaN(Date.parse(value.d)));
  if (typeof value?.id !== "string" || !dateOk) throw new ListCursorError("Virheellinen sivutuskursori");
  return { d: value.d ?? null, id: value.id };
}

/** True when the request asks for the paged shape (`?cursor=` or `?limit=` present). */
export function wantsListPage(params: URLSearchParams): boolean {
  return params.has("cursor") || params.has("limit");
}

/** Parses `?cursor=&limit=`; throws ListCursorError on a bad value. */
export function parseListPage(params: URLSearchParams): { cursor: ListCursor | null; limit: number } {
  const rawLimit = params.get("limit");
  const limit = rawLimit ? Number(rawLimit) : LIST_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_PAGE_MAX) {
    throw new ListCursorError(`limit on 1–${LIST_PAGE_MAX}`);
  }
  const raw = params.get("cursor");
  return { cursor: raw ? decodeListCursor(raw) : null, limit };
}

/**
 * Rows after the cursor in the list order `[dateField desc, id desc]`. SQLite sorts NULL lowest, so
 * undated rows come last in a descending order and are reached after every dated one.
 */
export function afterListCursor(cursor: ListCursor, dateField: string, nullable = true): Record<string, unknown> {
  if (cursor.d === null) {
    if (!nullable) throw new ListCursorError("Virheellinen sivutuskursori");
    return { [dateField]: null, id: { lt: cursor.id } };
  }
  const date = new Date(cursor.d);
  const after: Array<Record<string, unknown>> = [{ [dateField]: { lt: date } }, { [dateField]: date, id: { lt: cursor.id } }];
  // Prisma refuses `null` on a required column, so the undated branch exists only where it can match.
  if (nullable) after.push({ [dateField]: null });
  return { OR: after };
}

/** The same for `[dateField asc, id asc]` over a required (never NULL) date column. */
export function afterListCursorAsc(cursor: ListCursor, dateField: string): Record<string, unknown> {
  if (cursor.d === null) throw new ListCursorError("Virheellinen sivutuskursori");
  const date = new Date(cursor.d);
  return { OR: [{ [dateField]: { gt: date } }, { [dateField]: date, id: { gt: cursor.id } }] };
}

export type ListPage = ReturnType<typeof parseListPage>;
