import { createHmac } from "crypto";
import { vi } from "vitest";

/**
 * An in-memory stand-in for api.stripe.com, installed as the global fetch.
 * It keeps just enough state for the POS flows (accounts, locations,
 * PaymentIntents, charges, refunds) and records every request so a test can
 * check the headers (Stripe-Account, Idempotency-Key) and form bodies sent.
 */
export interface StripeCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  form: URLSearchParams;
}

interface FakeIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  amount_received: number;
  currency: string;
  status: string;
  client_secret: string;
  metadata: Record<string, string>;
  description: string | null;
  account: string;
  latest_charge: string | null;
  last_payment_error: { code?: string; message?: string } | null;
}

interface FakeCharge {
  id: string;
  object: "charge";
  amount: number;
  amount_refunded: number;
  payment_intent: string;
  refunded: boolean;
  payment_method_details: { type: string; card_present: { brand: string; last4: string } };
}

export interface FakeStripe {
  calls: StripeCall[];
  accounts: Map<string, { id: string; charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean }>;
  intents: Map<string, FakeIntent>;
  charges: Map<string, FakeCharge>;
  /** Moves a PaymentIntent to a state, as the reader would. */
  setIntent(id: string, status: string, options?: { amountReceived?: number }): FakeIntent;
  setAccount(id: string, flags: Partial<{ charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean }>): void;
  /** Next request answers with this Stripe error instead. */
  failNext(status: number, error: Record<string, unknown>): void;
  callsTo(method: string, pathPrefix: string): StripeCall[];
}

export function installFakeStripe(): FakeStripe {
  let seq = 0;
  const next = (prefix: string) => `${prefix}_test_${(seq += 1).toString().padStart(4, "0")}`;
  const idempotent = new Map<string, unknown>();
  let pendingFailure: { status: number; error: Record<string, unknown> } | null = null;

  const state: FakeStripe = {
    calls: [],
    accounts: new Map(),
    intents: new Map(),
    charges: new Map(),
    setIntent(id, status, options = {}) {
      const intent = state.intents.get(id);
      if (!intent) throw new Error(`no intent ${id}`);
      intent.status = status;
      if (status === "succeeded") {
        intent.amount_received = options.amountReceived ?? intent.amount;
        const charge: FakeCharge = {
          id: next("ch"),
          object: "charge",
          amount: intent.amount_received,
          amount_refunded: 0,
          payment_intent: intent.id,
          refunded: false,
          payment_method_details: { type: "card_present", card_present: { brand: "visa", last4: "4242" } },
        };
        state.charges.set(charge.id, charge);
        intent.latest_charge = charge.id;
      }
      if (status === "requires_payment_method") {
        intent.last_payment_error = { code: "card_declined", message: "Your card was declined." };
      }
      return intent;
    },
    setAccount(id, flags) {
      const account = state.accounts.get(id);
      if (!account) throw new Error(`no account ${id}`);
      Object.assign(account, flags);
    },
    failNext(status, error) {
      pendingFailure = { status, error };
    },
    callsTo(method, pathPrefix) {
      return state.calls.filter((call) => call.method === method && call.path.startsWith(pathPrefix));
    },
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const notFound = () =>
    json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, 404);

  function intentView(intent: FakeIntent, expand: string[]) {
    const { account: _account, ...rest } = intent;
    void _account;
    if (expand.includes("latest_charge") && intent.latest_charge) {
      return { ...rest, latest_charge: state.charges.get(intent.latest_charge) };
    }
    return rest;
  }

  function handle(call: StripeCall): Response {
    const { method, path, form } = call;
    const account = call.headers.get("stripe-account") ?? "";

    if (method === "POST" && path === "/v1/accounts") {
      const created = { id: next("acct"), charges_enabled: false, payouts_enabled: false, details_submitted: false };
      state.accounts.set(created.id, created);
      return json({ object: "account", ...created });
    }
    let match = /^\/v1\/accounts\/([^/]+)$/.exec(path);
    if (method === "GET" && match) {
      const found = state.accounts.get(match[1]);
      return found ? json({ object: "account", ...found }) : notFound();
    }
    if (method === "POST" && path === "/v1/account_links") {
      return json({ object: "account_link", url: `https://connect.stripe.test/setup/${form.get("account")}` });
    }
    if (method === "POST" && path === "/v1/terminal/locations") {
      return json({ object: "terminal.location", id: next("tml") });
    }
    if (method === "POST" && path === "/v1/terminal/connection_tokens") {
      return json({ object: "terminal.connection_token", secret: `pst_test_${account}` });
    }
    if (method === "POST" && path === "/v1/payment_intents") {
      const metadata: Record<string, string> = {};
      for (const [key, value] of form) {
        const meta = /^metadata\[(.+)\]$/.exec(key);
        if (meta) metadata[meta[1]] = value;
      }
      const id = next("pi");
      const intent: FakeIntent = {
        id,
        object: "payment_intent",
        amount: Number(form.get("amount")),
        amount_received: 0,
        currency: form.get("currency") ?? "eur",
        status: "requires_payment_method",
        client_secret: `${id}_secret_abc`,
        metadata,
        description: form.get("description"),
        account,
        latest_charge: null,
        last_payment_error: null,
      };
      state.intents.set(id, intent);
      return json(intentView(intent, []));
    }
    match = /^\/v1\/payment_intents\/([^/]+)(\/cancel)?$/.exec(path);
    if (match) {
      const intent = state.intents.get(match[1]);
      if (!intent || intent.account !== account) return notFound();
      if (method === "POST" && match[2]) {
        if (intent.status === "succeeded" || intent.status === "canceled") {
          return json(
            { error: { type: "invalid_request_error", code: "payment_intent_unexpected_state", message: "bad state" } },
            400
          );
        }
        intent.status = "canceled";
        return json(intentView(intent, []));
      }
      if (method === "GET") return json(intentView(intent, call.query.getAll("expand[]")));
    }
    if (method === "POST" && path === "/v1/refunds") {
      const intent = state.intents.get(form.get("payment_intent") ?? "");
      if (!intent || intent.account !== account || !intent.latest_charge) return notFound();
      const charge = state.charges.get(intent.latest_charge)!;
      const amount = form.has("amount") ? Number(form.get("amount")) : charge.amount - charge.amount_refunded;
      if (amount > charge.amount - charge.amount_refunded) {
        return json({ error: { type: "invalid_request_error", code: "amount_too_large", message: "too large" } }, 400);
      }
      charge.amount_refunded += amount;
      charge.refunded = charge.amount_refunded === charge.amount;
      return json({ object: "refund", id: next("re"), amount, status: "succeeded", payment_intent: intent.id, charge: charge.id });
    }
    return json({ error: { type: "invalid_request_error", message: `unhandled ${method} ${path}` } }, 404);
  }

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.origin !== "https://api.stripe.com") throw new Error(`unexpected fetch ${url}`);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      const call: StripeCall = { method, path: url.pathname, query: url.searchParams, headers, form };
      state.calls.push(call);
      if (pendingFailure) {
        const failure = pendingFailure;
        pendingFailure = null;
        return json({ error: failure.error }, failure.status);
      }
      const key = headers.get("idempotency-key");
      const cacheKey = key ? `${headers.get("stripe-account") ?? ""}|${key}` : null;
      if (cacheKey && idempotent.has(cacheKey)) return json(idempotent.get(cacheKey));
      const response = handle(call);
      if (cacheKey && response.ok) idempotent.set(cacheKey, await response.clone().json());
      return response;
    })
  );
  return state;
}

/** A Stripe-Signature header for `payload`, as Stripe computes it. */
export function stripeSignature(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}
