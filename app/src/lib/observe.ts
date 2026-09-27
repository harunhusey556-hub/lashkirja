/**
 * Opt-in error and latency reporting.
 *
 * Events are structured log lines. Nothing here stores a password, token,
 * cookie, session, IBAN, or SMTP secret. A webhook or Sentry DSN is used only
 * when the matching environment variable is set.
 */

export type ObserveKind =
  | "client_error"
  | "request"
  | "slow_query"
  | "job_failure"
  | "health";

export interface ObserveEvent {
  kind: ObserveKind;
  message: string;
  durationMs?: number;
  route?: string;
  status?: number;
  model?: string;
  operation?: string;
}

const SECRET_KEY = /password|token|secret|authorization|cookie|session|iban|smtp|api[-_]?key/i;
const clientReports: number[] = [];

export function slowQueryMs(): number {
  const parsed = Number(process.env.SLOW_QUERY_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
}

export function resetObserveForTests(): void {
  clientReports.length = 0;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
      .slice(0, 300);
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactValue(item, depth + 1);
    }
    return out;
  }
  return "[unsupported]";
}

/** Drop query strings so a client error cannot carry a token from the URL. */
export function publicErrorMessage(message: string): string {
  const redacted = String(redactValue(message) ?? "");
  return redacted
    .replace(/https?:\/\/\S+/g, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return "[url]";
      }
    })
    .slice(0, 300);
}

export function allowClientReport(now = Date.now()): boolean {
  while (clientReports.length > 0 && now - clientReports[0] > 60_000) clientReports.shift();
  if (clientReports.length >= 10) return false;
  clientReports.push(now);
  return true;
}

/** Public Sentry key stays in the envelope URL. It is not written to the log. */
export function sentryEnvelopeUrl(dsn: string): string | null {
  try {
    const url = new URL(dsn);
    const key = url.username;
    const project = url.pathname.replace(/^\//, "").split("/")[0];
    if (!key || !project || key === "null") return null;
    return `${url.protocol}//${url.host}/api/${project}/envelope/?sentry_key=${encodeURIComponent(key)}`;
  } catch {
    return null;
  }
}

function logEvent(event: ObserveEvent): void {
  const safe = redactValue(event) as ObserveEvent;
  const line = JSON.stringify({ observe: true, ...safe });
  if (event.kind === "request" || event.kind === "slow_query") console.info(line);
  else console.error(line);
}

function deliver(event: ObserveEvent): void {
  const safe = redactValue(event);
  const webhook = process.env.OBSERVE_WEBHOOK_URL?.trim();
  if (webhook) {
    void fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(safe),
    }).catch(() => {});
  }
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;
  if (event.kind !== "client_error" && event.kind !== "job_failure" && event.kind !== "health") return;
  const envelopeUrl = sentryEnvelopeUrl(dsn);
  if (!envelopeUrl) return;
  const payload = JSON.stringify(safe);
  const envelope = `{"type":"event"}\n${payload}`;
  void fetch(envelopeUrl, {
    method: "POST",
    headers: { "content-type": "application/x-sentry-envelope" },
    body: envelope,
  }).catch(() => {});
}

export function reportEvent(event: ObserveEvent): void {
  logEvent(event);
  deliver(event);
}

export function noteRequest(event: { route: string; status: number; durationMs: number }): void {
  reportEvent({ kind: "request", message: event.route, ...event });
}

export async function timeDb<T>(model: string, operation: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const durationMs = Date.now() - started;
    if (durationMs >= slowQueryMs()) {
      reportEvent({
        kind: "slow_query",
        message: `${model}.${operation}`,
        model,
        operation,
        durationMs,
      });
    }
  }
}

export function noteJobFailure(kind: string, message: string): void {
  reportEvent({
    kind: "job_failure",
    message: publicErrorMessage(message).slice(0, 300),
    route: kind,
  });
}
