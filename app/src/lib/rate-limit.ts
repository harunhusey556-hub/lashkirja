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
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      // Take the entry closest to us (the rightmost one), not the one
      // closest to the client (the leftmost one). This app is reachable
      // only through one trusted hop -- Tailscale Funnel/tailscaled
      // forwarding to 127.0.0.1:3300 -- and a well-behaved proxy chain
      // appends each hop's own view of the previous hop's address, so the
      // rightmost entry is the one that hop actually observed. The
      // leftmost entry, by contrast, can be set to anything by the
      // original client and nothing downstream is guaranteed to strip or
      // overwrite it. Taking the rightmost is never worse than the
      // leftmost (single-value headers are unaffected) and closes a login
      // rate-limit bypass if Funnel ever appends to rather than replaces a
      // client-supplied header (final review M11 -- unverified against
      // live Funnel traffic, so this is the conservative choice rather
      // than trusting the leftmost value blindly).
      const hops = forwarded
        .split(",")
        .map((hop) => hop.trim())
        .filter(Boolean);
      const nearest = hops[hops.length - 1];
      if (nearest) return nearest.slice(0, 128);
    }
  }
  return "direct";
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
}

