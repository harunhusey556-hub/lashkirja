/**
 * The app reports how long it had been unused when it opened ("usage_gap"),
 * as a histogram of buckets. Rows carry no user, session or exact time, only
 * the phone's random per-event id (for counting a resent batch once), so the
 * log answers "how often do people come back after a month" and nothing about who.
 */
export const USAGE_GAP_BUCKETS = ["<1h", "1-12h", "12-24h", "1-3d", "3-7d", "7-30d", ">30d"] as const;
export const USAGE_GAP_SCREENS = ["launch", "foreground"] as const;

export type UsageGapBucket = (typeof USAGE_GAP_BUCKETS)[number];
export type UsageGapScreen = (typeof USAGE_GAP_SCREENS)[number];

export function isUsageGap(name: unknown, screen: unknown): name is UsageGapBucket {
  return (
    typeof name === "string" &&
    (USAGE_GAP_BUCKETS as readonly string[]).includes(name) &&
    typeof screen === "string" &&
    (USAGE_GAP_SCREENS as readonly string[]).includes(screen)
  );
}

export type UsageGapCounts = Record<UsageGapBucket, Record<UsageGapScreen, number>>;

export function emptyUsageGapCounts(): UsageGapCounts {
  const counts = {} as UsageGapCounts;
  for (const bucket of USAGE_GAP_BUCKETS) counts[bucket] = { launch: 0, foreground: 0 };
  return counts;
}

/** Counts usage_gap lines; anything else (and unknown buckets) is skipped. A batch sent again
 * after a lost answer repeats its events: a line whose eventId was already counted is skipped. */
export function tallyUsageGaps(events: Iterable<Record<string, unknown>>): UsageGapCounts {
  const counts = emptyUsageGapCounts();
  const seen = new Set<string>();
  for (const event of events) {
    if (event.kind !== "usage_gap" || !isUsageGap(event.name, event.screen)) continue;
    if (typeof event.eventId === "string") {
      if (seen.has(event.eventId)) continue;
      seen.add(event.eventId);
    }
    counts[event.name][event.screen as UsageGapScreen] += 1;
  }
  return counts;
}

/** Bucket x launch/foreground, each as count and percent of that column's total. */
export function formatUsageGaps(counts: UsageGapCounts): string {
  const total = (screen: UsageGapScreen) =>
    USAGE_GAP_BUCKETS.reduce((sum, bucket) => sum + counts[bucket][screen], 0);
  const totals = { launch: total("launch"), foreground: total("foreground") };
  const cell = (value: number, of: number) =>
    `${String(value).padStart(6)} ${(of === 0 ? "-" : `${((100 * value) / of).toFixed(1)}%`).padStart(6)}`;
  const lines = [`${"gap".padEnd(8)}  ${"launch".padStart(13)}  ${"foreground".padStart(13)}`];
  for (const bucket of USAGE_GAP_BUCKETS) {
    lines.push(
      `${bucket.padEnd(8)}  ${cell(counts[bucket].launch, totals.launch)}  ${cell(counts[bucket].foreground, totals.foreground)}`
    );
  }
  lines.push(`${"total".padEnd(8)}  ${cell(totals.launch, totals.launch)}  ${cell(totals.foreground, totals.foreground)}`);
  return lines.join("\n");
}
