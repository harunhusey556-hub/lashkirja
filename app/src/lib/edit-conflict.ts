import { ConflictError } from "./api-errors";

/**
 * A save that names the version it edited must not overwrite a newer write.
 * Callers that omit the version keep the previous behaviour.
 */
export function assertCurrentVersion(current: Date, expected: string | null | undefined): void {
  if (!expected) return;
  const expectedMs = new Date(expected).getTime();
  if (!Number.isFinite(expectedMs) || current.getTime() !== expectedMs) {
    throw new ConflictError(
      "Tiedot ovat muuttuneet toisessa näkymässä. Lataa tiedot uudelleen ennen tallennusta."
    );
  }
}
