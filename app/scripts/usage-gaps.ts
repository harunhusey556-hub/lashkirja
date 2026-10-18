/**
 * How long the app sat unused before it was opened, from the anonymous
 * "usage_gap" events in the event log (lib/event-log.ts). Read-only.
 *
 *   npm run usage-gaps                 (last 30 days)
 *   npm run usage-gaps -- --days 7
 *   npm run usage-gaps -- --dir C:\LashKirja\logs
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { eventLogDir } from "../src/lib/event-log";
import { formatUsageGaps, tallyUsageGaps } from "../src/lib/usage-gap";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const dir = arg("dir") ?? eventLogDir();
  const days = Number(arg("days") ?? 30);
  if (!Number.isInteger(days) || days < 1) throw new Error(`--days: use a whole number of days (got ${arg("days")})`);
  const since = Date.now() - days * 86_400_000;
  const sinceDay = new Date(since).toISOString().slice(0, 10);

  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => /^events-\d{4}-\d{2}-\d{2}\.log$/.test(name) && name.slice(7, 17) >= sinceDay)
    .sort();
  if (files.length === 0) {
    console.log(`No event log files in ${dir} since ${sinceDay}.`);
    return;
  }

  const events: Record<string, unknown>[] = [];
  for (const file of files) {
    for (const line of (await readFile(path.join(dir, file), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.kind === "usage_gap" && Date.parse(String(event.ts)) >= since) events.push(event);
      } catch {
        console.warn(`skipped an unreadable line in ${file}`);
      }
    }
  }

  console.log(formatUsageGaps(tallyUsageGaps(events)));
  console.log(`— ${events.length} events from ${files.length} files in the last ${days} days (${dir})`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
