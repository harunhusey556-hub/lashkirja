/**
 * A small typed client for the Stripe REST API (no SDK dependency).
 *
 * - The secret key is read from STRIPE_SECRET_KEY on every call and is never
 *   logged, returned or put into an error.
 * - Bodies are application/x-www-form-urlencoded with Stripe's bracket syntax
 *   for nested objects and arrays.
 * - `account` sends the Stripe-Account header (Connect direct charges: the call
 *   acts on the business's own connected account).
 * - `idempotencyKey` sends the Idempotency-Key header, so a retried create
 *   returns the first result instead of creating a second object.
 * - Every failure becomes a StripeApiError with a Finnish message. Stripe's own
 *   message, request id and parameters stay in the server log at most.
 * - The API version is pinned here, in one place.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { AppError } from "./api-errors";

export const STRIPE_API_VERSION = "2026-05-27.dahlia";
const API_BASE = "https://api.stripe.com";
const TIMEOUT_MS = 20_000;
/** Stripe's own default tolerance for a webhook timestamp. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export const POS_DISABLED_MESSAGE = "Korttimaksut eivät ole käytössä tällä palvelimella.";

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

/**
 * The configured key is a Stripe test-mode key (secret or restricted). Only the
 * prefix is read; the key itself never leaves this module.
 */
export function stripeTestMode(): boolean {
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  return key.startsWith("sk_test_") || key.startsWith("rk_test_");
}

/**
 * The configured key is a Stripe live key. Only the prefix is read. Anything
 * that is not clearly live (a test key, an unknown prefix) counts as test, so
 * a card payment is booked only with a live key.
 */
export function stripeLiveKey(): boolean {
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  return key.startsWith("sk_live_") || key.startsWith("rk_live_");
}

/**
 * A card payment is real money only when Stripe says so (livemode true) and
 * the server is on a live key. Everything else is a test payment.
 */
export function isLivePayment(livemode: boolean | null | undefined): boolean {
  return livemode === true && stripeLiveKey();
}

export function webhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() || null;
}

/** The server has no Stripe key: every card payment route answers 503. */
export class StripeDisabledError extends AppError {
  constructor() {
    super(POS_DISABLED_MESSAGE, "POS_DISABLED", 503);
  }
}

export class StripeApiError extends AppError {
  /** Stripe's error type and code, for decisions in code. Never shown to the user. */
  readonly stripeType: string | null;
  readonly stripeCode: string | null;
  readonly httpStatus: number;

  constructor(message: string, statusCode: number, code: string, info: { type?: string | null; code?: string | null; httpStatus: number }) {
    super(message, code, statusCode);
    this.name = "StripeApiError";
    this.stripeType = info.type ?? null;
    this.stripeCode = info.code ?? null;
    this.httpStatus = info.httpStatus;
  }
}

// ---------------------------------------------------------------------------
// Form encoding
// ---------------------------------------------------------------------------

export type FormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FormValue[]
  | { [key: string]: FormValue };

/**
 * Stripe's form encoding: `a[b][c]=v` for nested objects, `a[]=v` for arrays
 * of scalars and `a[0][b]=v` for arrays of objects. null/undefined are left out.
 */
export function encodeForm(params: Record<string, FormValue>): string {
  const pairs: Array<[string, string]> = [];
  const walk = (key: string, value: FormValue) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const scalar = item === null || typeof item !== "object";
        walk(scalar ? `${key}[]` : `${key}[${index}]`, item);
      });
      return;
    }
    if (typeof value === "object") {
      for (const [child, childValue] of Object.entries(value)) walk(`${key}[${child}]`, childValue);
      return;
    }
    pairs.push([key, String(value)]);
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}

/** Stripe object ids go into URL paths; anything else is refused. */
export function stripeId(value: string): string {
  if (!/^[A-Za-z0-9_]{3,255}$/.test(value)) {
    throw new StripeApiError("Korttimaksun tunniste on virheellinen.", 400, "STRIPE_BAD_ID", { httpStatus: 0 });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface StripeRequestOptions {
  /** Connected account id: sent as the Stripe-Account header. */
  account?: string | null;
  idempotencyKey?: string | null;
  timeoutMs?: number;
}

interface StripeErrorBody {
  error?: { type?: string; code?: string; decline_code?: string };
}

function mapError(status: number, body: StripeErrorBody | null): StripeApiError {
  const type = body?.error?.type ?? null;
  const code = body?.error?.code ?? null;
  const info = { type, code, httpStatus: status };
  if (status === 401 || status === 403) {
    return new StripeApiError(
      "Korttimaksupalvelun asetukset ovat virheelliset. Ota yhteyttä tukeen.",
      503,
      "STRIPE_CONFIGURATION",
      info
    );
  }
  if (type === "card_error" || status === 402) {
    return new StripeApiError("Korttimaksu hylättiin. Kokeile toista korttia.", 402, "STRIPE_CARD_DECLINED", info);
  }
  if (type === "idempotency_error" || status === 409) {
    return new StripeApiError(
      "Sama korttimaksupyyntö on jo käsittelyssä. Yritä hetken päästä uudelleen.",
      409,
      "STRIPE_IDEMPOTENCY",
      info
    );
  }
  if (status === 429) {
    return new StripeApiError(
      "Korttimaksupalvelu on ruuhkautunut. Yritä hetken päästä uudelleen.",
      503,
      "STRIPE_RATE_LIMITED",
      info
    );
  }
  if (status >= 500) {
    return new StripeApiError(
      "Korttimaksupalvelussa on häiriö. Yritä hetken päästä uudelleen.",
      502,
      "STRIPE_UNAVAILABLE",
      info
    );
  }
  return new StripeApiError(
    "Korttimaksupalvelu ei hyväksynyt pyyntöä. Yritä uudelleen tai ota yhteyttä tukeen.",
    502,
    "STRIPE_REJECTED",
    info
  );
}

/**
 * One call to the Stripe API. `params` go into the query string for GET and
 * into the form body otherwise.
 */
export async function stripeRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, FormValue> = {},
  options: StripeRequestOptions = {}
): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new StripeDisabledError();
  if (!path.startsWith("/v1/")) throw new Error("Stripe path must start with /v1/");

  const encoded = encodeForm(params);
  const url = method === "GET" && encoded ? `${API_BASE}${path}?${encoded}` : `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Stripe-Version": STRIPE_API_VERSION,
    Accept: "application/json",
  };
  if (method !== "GET") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (options.account) headers["Stripe-Account"] = stripeId(options.account);
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey.slice(0, 255);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === "GET" ? undefined : encoded,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    console.error("[stripe] request failed", method, path, timedOut ? "timeout" : "network");
    throw new StripeApiError(
      "Korttimaksupalveluun ei saatu yhteyttä. Yritä hetken päästä uudelleen.",
      504,
      "STRIPE_UNREACHABLE",
      { httpStatus: 0 }
    );
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const mapped = mapError(response.status, body as StripeErrorBody | null);
    // Only the classification is logged: no key, no Stripe message, no params.
    console.error("[stripe] api error", method, path, response.status, mapped.stripeType, mapped.stripeCode, response.headers.get("request-id") ?? "");
    throw mapped;
  }
  if (!body || typeof body !== "object") {
    throw new StripeApiError("Korttimaksupalvelun vastausta ei voitu lukea.", 502, "STRIPE_BAD_RESPONSE", {
      httpStatus: response.status,
    });
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Resources (only the fields this app reads)
// ---------------------------------------------------------------------------

export interface StripeAccount {
  id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
}

export interface StripeCharge {
  id: string;
  amount: number;
  amount_refunded: number;
  payment_intent: string | null;
  refunded?: boolean;
  livemode?: boolean;
  payment_method_details?: {
    type?: string;
    card_present?: { brand?: string | null; last4?: string | null } | null;
    interac_present?: { brand?: string | null; last4?: string | null } | null;
  } | null;
}

export type PaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "canceled"
  | "succeeded";

export interface StripePaymentIntent {
  id: string;
  amount: number;
  amount_received: number;
  currency: string;
  status: PaymentIntentStatus | string;
  client_secret: string | null;
  metadata: Record<string, string>;
  latest_charge: string | StripeCharge | null;
  last_payment_error?: { code?: string | null; decline_code?: string | null; message?: string | null } | null;
  /** false for a Stripe test-mode object. */
  livemode: boolean;
}

export interface StripeRefund {
  id: string;
  amount: number;
  status: string | null;
  payment_intent: string | null;
}

export interface StripeEvent {
  id: string;
  type: string;
  /** Set on Connect events: the connected account the event happened on. */
  account?: string | null;
  /** false for an event from Stripe's test mode. */
  livemode?: boolean;
  data: { object: Record<string, unknown> };
}

export function createExpressAccount(
  params: { email: string; businessType: "individual" | "company" | null; userId: string },
  idempotencyKey: string
): Promise<StripeAccount> {
  return stripeRequest<StripeAccount>(
    "POST",
    "/v1/accounts",
    {
      type: "express",
      country: "FI",
      email: params.email,
      business_type: params.businessType ?? undefined,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { userId: params.userId },
    },
    { idempotencyKey }
  );
}

export function retrieveAccount(accountId: string): Promise<StripeAccount> {
  return stripeRequest<StripeAccount>("GET", `/v1/accounts/${stripeId(accountId)}`);
}

export function createAccountLink(params: {
  account: string;
  refreshUrl: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  return stripeRequest<{ url: string }>("POST", "/v1/account_links", {
    account: stripeId(params.account),
    refresh_url: params.refreshUrl,
    return_url: params.returnUrl,
    type: "account_onboarding",
  });
}

export function createTerminalLocation(
  account: string,
  params: { displayName: string; line1: string; city: string; postalCode: string },
  idempotencyKey: string
): Promise<{ id: string }> {
  return stripeRequest<{ id: string }>(
    "POST",
    "/v1/terminal/locations",
    {
      display_name: params.displayName,
      address: { line1: params.line1, city: params.city, postal_code: params.postalCode, country: "FI" },
    },
    { account, idempotencyKey }
  );
}

export function createConnectionToken(account: string, location: string | null): Promise<{ secret: string }> {
  return stripeRequest<{ secret: string }>(
    "POST",
    "/v1/terminal/connection_tokens",
    { location: location ?? undefined },
    { account }
  );
}

export function createCardPresentIntent(
  account: string,
  params: { amountCents: number; description: string; metadata: Record<string, string> },
  idempotencyKey: string
): Promise<StripePaymentIntent> {
  return stripeRequest<StripePaymentIntent>(
    "POST",
    "/v1/payment_intents",
    {
      amount: params.amountCents,
      currency: "eur",
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      description: params.description,
      metadata: params.metadata,
    },
    { account, idempotencyKey }
  );
}

export function retrievePaymentIntent(account: string, id: string): Promise<StripePaymentIntent> {
  return stripeRequest<StripePaymentIntent>(
    "GET",
    `/v1/payment_intents/${stripeId(id)}`,
    { expand: ["latest_charge"] },
    { account }
  );
}

export function cancelPaymentIntent(account: string, id: string): Promise<StripePaymentIntent> {
  return stripeRequest<StripePaymentIntent>("POST", `/v1/payment_intents/${stripeId(id)}/cancel`, {}, { account });
}

export function createRefund(
  account: string,
  params: { paymentIntent: string; amountCents: number; metadata: Record<string, string> },
  idempotencyKey: string
): Promise<StripeRefund> {
  return stripeRequest<StripeRefund>(
    "POST",
    "/v1/refunds",
    { payment_intent: stripeId(params.paymentIntent), amount: params.amountCents, metadata: params.metadata },
    { account, idempotencyKey }
  );
}

// ---------------------------------------------------------------------------
// Webhook signatures
// ---------------------------------------------------------------------------

/**
 * Checks a `Stripe-Signature: t=…,v1=…` header: HMAC-SHA256 over `${t}.${rawBody}`
 * with the endpoint secret, compared in constant time, and a timestamp no
 * further than the tolerance from now (a replayed old event is refused).
 */
export function verifyWebhookSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  options: { toleranceSeconds?: number; nowMs?: number } = {}
): boolean {
  if (!header || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (timestamp === null || signatures.length === 0) return false;
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) return false;

  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex"), "utf8");
  return signatures.some((candidate) => {
    const given = Buffer.from(candidate, "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
