/**
 * The list rows Kuitit has shown, kept by id so a receipt opened from the list
 * can paint its title, amount and date at once while the full receipt loads
 * (the detail route "opens from the cached row and fills in"). Display only:
 * the editor never starts from these, they miss most of the fields.
 */
const MAX_SEEDS = 500;
const seeds = new Map<string, unknown>();

export function rememberReceiptRows<T extends { id: string }>(rows: readonly T[]): void {
  for (const row of rows) {
    // Re-inserting moves the row to the newest end, so the oldest are dropped first.
    seeds.delete(row.id);
    seeds.set(row.id, row);
  }
  while (seeds.size > MAX_SEEDS) {
    const oldest = seeds.keys().next().value;
    if (oldest === undefined) break;
    seeds.delete(oldest);
  }
}

export function recallReceiptRow<T>(id: string): T | undefined {
  return seeds.get(id) as T | undefined;
}

export function clearReceiptRowSeeds(): void {
  seeds.clear();
}
