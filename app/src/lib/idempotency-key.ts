/** A new key for one submit attempt. Reuse it until that attempt succeeds. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
