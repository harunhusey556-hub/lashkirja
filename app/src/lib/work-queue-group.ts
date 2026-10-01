/**
 * Failed reads that look the same to the owner (same day, same reason) are one
 * row with a count and one retry that retries them all (F29). Pure, no database.
 */
import { jobTitle } from "./display-titles";

export interface FailedJob {
  id: string;
  kind: string;
  title?: string | null;
  error: string | null;
  createdAt: Date | string;
}

export interface FailedGroup {
  /** Newest job in the group: the row id and the back-compatible single retry. */
  id: string;
  title: string;
  detail: string;
  count: number;
  /** Every job the one retry starts again, newest first. */
  jobIds: string[];
}

export const FAILED_FALLBACK = "Kuvaa ei voitu lukea. Kokeile terävämpää kuvaa tai tekstipohjaista PDF:ää.";

export function groupFailedJobs(jobs: FailedJob[]): FailedGroup[] {
  const sorted = [...jobs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const groups = new Map<string, FailedGroup>();
  for (const job of sorted) {
    const base = jobTitle(job);
    const detail = job.error || FAILED_FALLBACK;
    const key = `${base}\u0000${detail}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.jobIds.push(job.id);
      continue;
    }
    groups.set(key, { id: job.id, title: base, detail, count: 1, jobIds: [job.id] });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    title: group.count > 1 ? `${group.title} (${group.count} kuvaa)` : group.title,
  }));
}
