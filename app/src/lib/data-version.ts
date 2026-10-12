/**
 * The client's one idea of "the data changed" (W20). A screen that shows money
 * reads `getDataVersion()` through `useDataVersion` and refetches when it moves.
 * It moves for two reasons:
 *
 * - the server says so: `GET /api/sync/version` is polled every 30 s while the
 *   tab is visible (and once when it becomes visible again), which is how a
 *   sync done by the 6-hourly job, another device or another tab reaches a
 *   screen that stays mounted;
 * - this tab changed something: `bumpDataVersion()` after a sync, an import or
 *   a save, so the screens that are open behind a sheet catch up at once.
 *
 * Pure and React-free so the rules are unit-tested; `useDataVersion.ts` wires
 * it to `apiFetch` and React.
 */

export const DATA_VERSION_POLL_MS = 30_000;
/** Bumps closer together than this count once: a bulk action of 40 requests refetches once. */
export const BUMP_COALESCE_MS = 250;

/** `GET /api/sync/version`. Every field is optional: an absent one is "unknown", never an error. */
export interface SyncVersionPayload {
  dataVersion?: unknown;
  bank?: {
    lastChangeAt?: unknown;
    accounts?: Array<{
      bankAccountId?: unknown;
      connectedAccountId?: unknown;
      lastSyncAt?: unknown;
      balanceCents?: unknown;
    }>;
  } | null;
  receipts?: { lastChangeAt?: unknown } | null;
  invoices?: { lastChangeAt?: unknown } | null;
}

/**
 * One string that changes when anything the server reports changes. The
 * counter alone would do, but a server that forgets to bump it for one kind of
 * write would then leave that screen stale for good, so the per-area markers
 * count as well.
 */
export function versionSignature(payload: SyncVersionPayload | null | undefined): string | null {
  if (!payload || typeof payload !== "object") return null;
  const accounts = Array.isArray(payload.bank?.accounts) ? payload.bank.accounts : [];
  const parts = [
    payload.dataVersion,
    payload.bank?.lastChangeAt,
    ...accounts.map(
      (account) => `${account?.bankAccountId ?? ""}:${account?.connectedAccountId ?? ""}:${account?.lastSyncAt}:${account?.balanceCents}`
    ),
    payload.receipts?.lastChangeAt,
    payload.invoices?.lastChangeAt,
  ].map((part) => (part === undefined || part === null ? "" : String(part)));
  if (parts.every((part) => part === "")) return null;
  return parts.join("|");
}

let token = 0;
let lastSignature: string | null = null;
let bumpTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function advance(): void {
  token += 1;
  for (const listener of [...listeners]) listener();
}

export function getDataVersion(): number {
  return token;
}

export function subscribeDataVersion(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * This tab changed data. Coalesced, so a loop of saves moves the version once.
 * The next poll will usually report the same change again; that costs one
 * extra refetch and is the price of not trusting a response shape.
 */
export function bumpDataVersion(): void {
  if (bumpTimer !== null) return;
  bumpTimer = setTimeout(() => {
    bumpTimer = null;
    advance();
  }, BUMP_COALESCE_MS);
}

/**
 * A poll answered. The first answer only records the baseline (a screen that
 * just mounted has just fetched); a different one moves the version.
 * Returns whether it moved.
 */
export function noteServerVersion(payload: SyncVersionPayload | null | undefined): boolean {
  const signature = versionSignature(payload);
  if (signature === null) return false;
  const previous = lastSignature;
  lastSignature = signature;
  if (previous === null || previous === signature) return false;
  advance();
  return true;
}

/** Tests, and sign-out: nothing known about the server any more. */
export function resetDataVersion(): void {
  if (bumpTimer !== null) clearTimeout(bumpTimer);
  bumpTimer = null;
  lastSignature = null;
  token = 0;
  listeners.clear();
}

export interface VersionPollerEnv {
  /** One poll. Resolves with the payload, or null when there is nothing to learn (offline, 401). */
  fetchVersion: () => Promise<SyncVersionPayload | null>;
  isVisible: () => boolean;
  /** Subscribes to the tab being shown or hidden; returns the unsubscribe. */
  onVisible: (callback: () => void) => () => void;
  intervalMs?: number;
}

/**
 * Polls while the tab is visible: now, then every `intervalMs`; a hidden tab
 * asks nothing, and coming back to the front asks at once. A poll still in
 * flight is never doubled. Returns the stop function.
 */
export function startVersionPolling(env: VersionPollerEnv): () => void {
  const intervalMs = env.intervalMs ?? DATA_VERSION_POLL_MS;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const poll = async () => {
    if (stopped || inFlight || !env.isVisible()) return;
    inFlight = true;
    try {
      const payload = await env.fetchVersion();
      if (!stopped) noteServerVersion(payload);
    } catch {
      // A failed poll is a missed look, not an error: the next one tries again.
    } finally {
      inFlight = false;
    }
  };

  const arm = () => {
    if (timer !== null) clearInterval(timer);
    timer = env.isVisible() ? setInterval(() => void poll(), intervalMs) : null;
  };

  const stopVisible = env.onVisible(() => {
    arm();
    void poll();
  });
  arm();
  void poll();

  return () => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
    stopVisible();
  };
}
