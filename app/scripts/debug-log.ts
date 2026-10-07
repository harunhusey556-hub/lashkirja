/**
 * Reads the event log (lib/event-log.ts) for debugging.
 *
 *   npm run debug-log -- --since 2h --errors
 *   npm run debug-log -- --report K7Q2XM        (a problem report and what led to it)
 *   npm run debug-log -- --request 3f9a2c1d     (one request, app and server side)
 *   npm run debug-log -- --since 1d --grep receipts --limit 50
 *
 * --dir overrides the folder (default: EVENT_LOG_DIR, else ./logs; production
 * is C:\LashKirja\logs). Prints one compact line per event, oldest first.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { eventLogDir } from "../src/lib/event-log";

type Event = Record<string, unknown> & { ts?: string; kind?: string };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

export function parseSince(value: string | undefined, now = Date.now()): number {
  const match = /^(\d+)\s*(m|h|d)$/.exec(value ?? "2h");
  if (!match) throw new Error(`--since: use e.g. 30m, 2h or 3d (got ${value})`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
  return now - Number(match[1]) * unit;
}

export function isProblem(event: Event): boolean {
  const status = typeof event.status === "number" ? event.status : 0;
  return event.kind === "error" || event.kind === "report" || (event.kind === "request" && status === 0) || status >= 400;
}

export function formatEvent(event: Event): string {
  // Helsinki time, as the owner tells it ("it broke at 14:00").
  const at = new Date(String(event.ts ?? ""));
  const time = Number.isNaN(at.getTime())
    ? String(event.ts ?? "?")
    : at.toLocaleString("sv-SE", { timeZone: "Europe/Helsinki" }).slice(5);
  const parts = [
    time,
    String(event.source ?? "?").padEnd(6),
    String(event.kind ?? "?").padEnd(8),
    event.method ? `${event.method} ${event.path ?? ""}` : (event.screen ?? event.name ?? event.path ?? ""),
    event.status !== undefined ? `→${event.status}` : "",
    event.durationMs !== undefined ? `${event.durationMs}ms` : "",
    event.requestId ? `rid=${event.requestId}` : "",
    event.message ? `| ${String(event.message).split("\n")[0]}` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

async function main() {
  const dir = arg("dir") ?? eventLogDir();
  const request = arg("request");
  const report = arg("report");
  const grep = arg("grep")?.toLowerCase();
  const limit = Number(arg("limit") ?? 300);
  // A report or request search looks back a week unless --since says otherwise.
  const since = parseSince(arg("since") ?? (request || report ? "7d" : "2h"));

  const sinceDay = new Date(since).toISOString().slice(0, 10);
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => /^events-\d{4}-\d{2}-\d{2}\.log$/.test(name) && name.slice(7, 17) >= sinceDay)
    .sort();
  if (files.length === 0) {
    console.log(`No event log files in ${dir} since ${sinceDay}.`);
    return;
  }

  let events: Event[] = [];
  for (const file of files) {
    for (const line of (await readFile(path.join(dir, file), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Event;
        if (Date.parse(String(event.ts)) >= since) events.push(event);
      } catch {
        console.warn(`skipped an unreadable line in ${file}`);
      }
    }
  }

  if (report) {
    // The report itself plus the same app session's trail in the 15 minutes before it.
    const hit = events.find((event) => event.kind === "report" && event.name === report);
    if (!hit) {
      console.log(`Report ${report} not found.`);
      return;
    }
    const at = Date.parse(String(hit.ts));
    events = events.filter(
      (event) =>
        (event.sessionId === hit.sessionId || event.source === "server") &&
        Date.parse(String(event.ts)) >= at - 15 * 60_000 &&
        Date.parse(String(event.ts)) <= at + 60_000
    );
  }
  if (request) events = events.filter((event) => event.requestId === request);
  if (flag("errors")) events = events.filter(isProblem);
  if (grep) events = events.filter((event) => JSON.stringify(event).toLowerCase().includes(grep));

  const shown = events.slice(-limit);
  for (const event of shown) {
    console.log(formatEvent(event));
    if (flag("stack") && typeof event.stack === "string") console.log(`    ${event.stack.split("\n").join("\n    ")}`);
  }
  console.log(`— ${shown.length}/${events.length} events from ${files.join(", ")} (${dir})`);
}

if (process.argv[1] && /debug-log/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
