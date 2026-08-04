import { createHash } from "crypto";
import type { NextRequest } from "next/server";

interface Bucket {
  count: number;
  resetAt: number;
}

const globalRateLimits = globalThis as unknown as {
  lashkirjaRateLimits?: Map<string, Bucket>;
};

const buckets =
  globalRateLimits.lashkirjaRateLimits ??
  (globalRateLimits.lashkirjaRateLimits = new Map<string, Bucket>());

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now()
): RateLimitResult {
  const existing = buckets.get(key);
  const bucket = !existing || existing.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : existing;

  bucket.count += 1;
  buckets.set(key, bucket);

  // Keep the process-local fallback bounded. Production multi-instance
  // deployments should replace this with a shared limiter at the proxy/store.
  if (buckets.size > 10_000) {
    for (const [candidate, value] of buckets) {
      if (value.resetAt <= now) buckets.delete(candidate);
      if (buckets.size <= 8_000) break;
    }
  }

  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

export function clearRateLimit(key: string): void {
  buckets.delete(key);
}

export function opaqueRateKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function requestClientKey(req: NextRequest): string {
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded.slice(0, 128);
  }
  return "direct";
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
}

