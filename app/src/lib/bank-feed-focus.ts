/**
 * `/pankki/tapahtumat?rivi=<id>` (the chat's "Avaa pankkitapahtuma", Koti rows) opens that row's
 * sheet once the rows have loaded, and only once: closing the sheet must not reopen it.
 */
export function focusRowId(
  param: string | null,
  rows: ReadonlyArray<{ id: string }>,
  alreadyOpened: boolean
): string | null {
  if (!param || alreadyOpened) return null;
  return rows.some((row) => row.id === param) ? param : null;
}
