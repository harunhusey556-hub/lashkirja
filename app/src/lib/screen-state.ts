import { ApiError, ApiGatewayError, ApiTimeoutError } from "@/components/clientFetch";

export type ConnectionKind = "offline" | "unreachable" | "expired" | "generic";

export const CONNECTION_COPY: Record<
  Exclude<ConnectionKind, "generic">,
  { title: string; body: string }
> = {
  offline: {
    title: "Ei verkkoyhteyttä",
    body: "Tarkista yhteys ja yritä uudelleen.",
  },
  unreachable: {
    title: "Palvelimeen ei saada yhteyttä",
    body: "Palvelin ei vastannut. Yritä hetken kuluttua uudelleen.",
  },
  expired: {
    title: "Istunto vanheni",
    body: "Kirjaudu sisään uudelleen.",
  },
};

function looksLikeNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return /failed to fetch|networkerror|load failed|network request failed/i.test(error.message);
}

/** Offline, unreachable, and an expired session are different situations. */
export function classifyConnection(error: unknown, online = true): ConnectionKind {
  if (error instanceof ApiError && error.status === 401) return "expired";
  if (error instanceof ApiTimeoutError || error instanceof ApiGatewayError) return "unreachable";
  if (looksLikeNetworkFailure(error)) return online ? "unreachable" : "offline";
  return "generic";
}

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export type EmptyKind = "records" | "filtered" | "failed" | "forbidden";

export function emptyKind(input: {
  count: number;
  hasActiveFilter?: boolean;
  failed?: boolean;
  forbidden?: boolean;
}): EmptyKind | null {
  if (input.forbidden) return "forbidden";
  if (input.failed && input.count === 0) return "failed";
  if (input.count > 0) return null;
  if (input.hasActiveFilter) return "filtered";
  return "records";
}

export function formatUpdatedAt(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) return `Viimeksi päivitetty tänään klo ${time}`;
  const day = date.toLocaleDateString("fi-FI");
  return `Viimeksi päivitetty ${day} klo ${time}`;
}

/** Shown only when a cached copy is on screen and the latest refresh failed. */
export function staleBannerText(
  fetchedAt: number | null,
  refreshFailed: boolean,
  now = Date.now()
): string | null {
  if (!refreshFailed || fetchedAt == null) return null;
  return formatUpdatedAt(fetchedAt, now);
}

/** Receipt upload / OCR phases. Names only — never a percentage. */
export const RECEIPT_PHASE = {
  upload: "Lähetetään",
  process: "Käsitellään",
  review: "Odottaa tarkistusta",
  done: "Valmis",
} as const;

export type ReceiptPhase = (typeof RECEIPT_PHASE)[keyof typeof RECEIPT_PHASE];

export function isHonestJobPhase(label: string): boolean {
  return (
    (Object.values(RECEIPT_PHASE) as string[]).includes(label) && !label.includes("%")
  );
}

/** Streaming responses keep an idle timer, separate from the shared request timeout. */
export const STREAM_IDLE_MS = 45_000;

export function armIdleTimeout(
  idleMs: number,
  onIdle: () => void
): { bump: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  const bump = () => {
    stop();
    timer = setTimeout(onIdle, idleMs);
  };
  bump();
  return { bump, stop };
}

let navEpoch = 0;
const overlayClosers = new Set<() => void>();

export function currentNavEpoch(): number {
  return navEpoch;
}

export function isStaleEpoch(seen: number): boolean {
  return seen !== navEpoch;
}

/** Route changes close overlays that belonged to the previous screen. */
export function bumpNavEpoch(): number {
  navEpoch += 1;
  for (const close of [...overlayClosers]) close();
  return navEpoch;
}

export function subscribeOverlayClose(close: () => void): () => void {
  overlayClosers.add(close);
  return () => overlayClosers.delete(close);
}

export function resetNavEpochForTests(): void {
  navEpoch = 0;
  overlayClosers.clear();
}

export function errorReference(commit: string, now = Date.now()): string {
  const short = (commit || "unknown").replace(/[^a-zA-Z0-9]/g, "").slice(0, 7) || "unknown";
  return `LK-${short}-${now.toString(36)}`;
}
