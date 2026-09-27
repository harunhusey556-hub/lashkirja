import { ConflictError } from "./api-errors";

export const VERSION_CONFLICT_MESSAGE =
  "Tiedot ovat muuttuneet toisessa näkymässä. Lataa tiedot uudelleen ennen tallennusta.";

/**
 * A save that names the version it edited must not overwrite a newer write.
 * Callers that omit the version keep the previous behaviour.
 */
export function assertCurrentVersion(current: Date, expected: string | null | undefined): void {
  if (!expected) return;
  const expectedMs = new Date(expected).getTime();
  if (!Number.isFinite(expectedMs) || current.getTime() !== expectedMs) {
    throw new ConflictError(VERSION_CONFLICT_MESSAGE);
  }
}

/** The instant a client sent back. Null means the caller did not send one. */
export function expectedUpdatedAtDate(expected: string | null | undefined): Date | null {
  if (!expected) return null;
  const expectedMs = new Date(expected).getTime();
  if (!Number.isFinite(expectedMs)) throw new ConflictError(VERSION_CONFLICT_MESSAGE);
  return new Date(expectedMs);
}

export function versionConflict(): ConflictError {
  return new ConflictError(VERSION_CONFLICT_MESSAGE);
}
