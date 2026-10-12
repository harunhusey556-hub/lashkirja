import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * The debugging trail: one JSON object per line in `logs/events-YYYY-MM-DD.log`
 * (production: C:\LashKirja\logs, where the supervisor prunes *.log after 30
 * days). Server errors land here with the request id the app sent, and the
 * app's own trail (screens, requests, problem reports) arrives through
 * POST /api/observe/events, so one id ties both sides together.
 * Read it with `npm run debug-log`.
 *
 * Only ids and actions: secrets are dropped by key name and long strings are cut.
 */

export interface LoggedEvent {
  source: "server" | "ios" | "web";
  kind: string;
  ts?: string;
  [key: string]: unknown;
}

const SECRET_KEY = /pass|token|secret|authorization|cookie|^code$|^otp$|^pin$|iban/i;
const MAX_STRING = 2000;
const MAX_DEPTH = 4;

export function eventLogDir(): string {
  return process.env.EVENT_LOG_DIR?.trim() || path.join(process.cwd(), "logs");
}

export function eventLogFile(date: Date, dir = eventLogDir()): string {
  return path.join(dir, `events-${date.toISOString().slice(0, 10)}.log`);
}

/** A copy without secret-looking keys, with strings cut to a readable length. */
export function scrubEvent(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrubEvent(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = scrubEvent(item, depth + 1);
  }
  return out;
}

// Appends run one after another so lines of two batches never interleave.
let chain: Promise<void> = Promise.resolve();

export function writeEvents(events: LoggedEvent[], now = new Date()): Promise<void> {
  if (events.length === 0) return chain;
  const lines = events
    .map((event) => JSON.stringify(scrubEvent({ ts: now.toISOString(), ...event })))
    .join("\n");
  const dir = eventLogDir();
  const file = eventLogFile(now, dir);
  chain = chain
    .then(async () => {
      await mkdir(dir, { recursive: true });
      await appendFile(file, `${lines}\n`, "utf8");
    })
    .catch((error: unknown) => console.error("[event-log] write failed:", file, error));
  return chain;
}

/** A server-side event; never throws and never delays the caller. */
export function logServerEvent(event: { kind: string; [key: string]: unknown }): void {
  void writeEvents([{ source: "server", ...event }]);
}

/** The fields of an unexpected error worth keeping: name, message and the top of the stack. */
export function errorFields(error: unknown): { errorName?: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      message: error.message,
      stack: error.stack?.split("\n").slice(0, 12).join("\n"),
    };
  }
  return { message: String(error) };
}
