import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { helsinkiCalendarDate, helsinkiMonthKey } from "@/lib/validation";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { GET as getInvoice } from "@/app/api/invoices/[id]/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { DELETE as deletePayment, POST as addPayment } from "@/app/api/invoices/[id]/payments/route";
import { GET as posStatus } from "@/app/api/pos/status/route";
import { POST as onboarding } from "@/app/api/pos/onboarding/route";
import { POST as refreshOnboarding } from "@/app/api/pos/onboarding/refresh/route";
import { GET as onboardingReturn } from "@/app/api/pos/onboarding/return/route";
import { PATCH as posSettings } from "@/app/api/pos/settings/route";
import { POST as connectionToken } from "@/app/api/pos/connection-token/route";
import { POST as createIntent } from "@/app/api/pos/payment-intents/route";
import { GET as listPayments } from "@/app/api/pos/payments/route";
import { POST as finalize } from "@/app/api/pos/payments/[id]/finalize/route";
import { POST as cancel } from "@/app/api/pos/payments/[id]/cancel/route";
import { POST as refund } from "@/app/api/pos/payments/[id]/refund/route";
import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { buildAccountCopyZip, completeAccountClose } from "@/lib/account-requests";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";
import { installFakeStripe, stripeSignature, type FakeStripe } from "./helpers/fake-stripe";

const SECRET_KEY = "sk_test_integration_key_never_logged";
const WEBHOOK_SECRET = "whsec_integration_secret";
// 100 + 25,5 % VAT = 125,50
const LINE = { description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 };

let user: TestUser;
let cookie: string;
let customerId: string;
let stripe: FakeStripe;

async function invoiceInState(status: "draft" | "sent" = "sent", as = cookie, customer = customerId) {
  const created = await readJson(
    await createInvoice(
      buildRequest(
        "POST",
        "/api/invoices",
        { customerId: customer, issueDate: "2026-01-15", dueDate: "2026-01-29", lines: [LINE] },
        { cookie: as }
      )
    )
  );
  const invoice = created.invoice;
  if (status === "sent") {
    const sent = await setStatus(
      buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "sent" }, { cookie: as }),
      routeContext({ id: invoice.id })
    );
    expect(sent.status).toBe(200);
  }
  return invoice as { id: string; number: number };
}

async function connectReadyAccount() {
  await prisma.user.update({
    where: { id: user.id },
    data: { addressStreet: "Ripsikatu 1", addressPostalCode: "00100", addressCity: "Helsinki", businessName: "Ripsistudio" },
  });
  expect((await onboarding(buildRequest("POST", "/api/pos/onboarding", {}, { cookie }))).status).toBe(200);
  const account = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).stripeAccountId!;
  stripe.setAccount(account, { charges_enabled: true, payouts_enabled: true, details_submitted: true });
  expect((await refreshOnboarding(buildRequest("POST", "/api/pos/onboarding/refresh", {}, { cookie }))).status).toBe(200);
  const enabled = await posSettings(buildRequest("PATCH", "/api/pos/settings", { posEnabled: true }, { cookie }));
  expect(enabled.status).toBe(200);
  return account;
}

function startPayment(invoiceId: string, amount: number, key?: string, as = cookie) {
  return createIntent(
    buildRequest("POST", "/api/pos/payment-intents", { invoiceId, amount }, {
      cookie: as,
      headers: key ? { "idempotency-key": key } : {},
    })
  );
}

const finalizeReq = (id: string) =>
  finalize(buildRequest("POST", `/api/pos/payments/${id}/finalize`, {}, { cookie }), routeContext({ id }));

function webhookRequest(event: unknown, options: { secret?: string; timestamp?: number; signature?: string } = {}) {
  const payload = JSON.stringify(event);
  const signature =
    options.signature ?? stripeSignature(payload, options.secret ?? WEBHOOK_SECRET, options.timestamp);
  return new NextRequest(new URL("/api/stripe/webhook", "http://localhost:3000"), {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
}

const invoicePayments = (invoiceId: string) => prisma.invoicePayment.findMany({ where: { invoiceId } });

async function openInvoice(invoiceId: string) {
  const response = await getInvoice(buildRequest("GET", `/api/invoices/${invoiceId}`, undefined, { cookie }), routeContext({ id: invoiceId }));
  return (await readJson(response)).invoice;
}

beforeEach(async () => {
  process.env.STRIPE_SECRET_KEY = SECRET_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  stripe = installFakeStripe();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  const customer = await readJson(
    await createCustomer(buildRequest("POST", "/api/customers", { name: "Anna Asiakas", email: "anna@example.fi" }, { cookie }))
  );
  customerId = customer.customer.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.APP_ORIGIN;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

describe("feature switch", () => {
  it("answers 503 on every POS route when the server has no Stripe key", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const responses = await Promise.all([
      posStatus(buildRequest("GET", "/api/pos/status", undefined, { cookie })),
      onboarding(buildRequest("POST", "/api/pos/onboarding", {}, { cookie })),
      connectionToken(buildRequest("POST", "/api/pos/connection-token", {}, { cookie })),
      startPayment("00000000-0000-4000-8000-000000000000", 10),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(503);
      expect((await readJson(response)).error).toBe("Korttimaksut eivät ole käytössä tällä palvelimella.");
    }
    expect(stripe.calls).toHaveLength(0);
  });

  it("requires a session", async () => {
    const response = await posStatus(buildRequest("GET", "/api/pos/status"));
    expect(response.status).toBe(401);
  });

  it("says testMode only for a Stripe test key, and never returns the key", async () => {
    for (const key of [SECRET_KEY, "rk_test_restricted_integration_key"]) {
      process.env.STRIPE_SECRET_KEY = key;
      const response = await posStatus(buildRequest("GET", "/api/pos/status", undefined, { cookie }));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ enabled: true, testMode: true });
      expect(text).not.toContain(key);
    }
    for (const key of ["sk_live_integration_key_never_logged", "rk_live_restricted_integration_key", "sk_testlike"]) {
      process.env.STRIPE_SECRET_KEY = key;
      const response = await posStatus(buildRequest("GET", "/api/pos/status", undefined, { cookie }));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ enabled: true, testMode: false });
      expect(text).not.toContain(key);
    }
    expect(stripe.calls).toHaveLength(0);
  });
});

describe("onboarding", () => {
  it("creates the connected account once and returns an onboarding link", async () => {
    process.env.APP_ORIGIN = "https://lashkirja.example.fi";
    await prisma.user.update({ where: { id: user.id }, data: { entityType: "oy" } });
    const first = await onboarding(buildRequest("POST", "/api/pos/onboarding", {}, { cookie }));
    expect(first.status).toBe(200);
    const body = await readJson(first);
    expect(body.url).toMatch(/^https:\/\/connect\.stripe\.test\/setup\/acct_/);

    const second = await onboarding(buildRequest("POST", "/api/pos/onboarding", {}, { cookie }));
    expect(second.status).toBe(200);

    const created = stripe.callsTo("POST", "/v1/accounts");
    expect(created).toHaveLength(1);
    expect(created[0].form.get("type")).toBe("express");
    expect(created[0].form.get("country")).toBe("FI");
    expect(created[0].form.get("business_type")).toBe("company");
    expect(created[0].form.get("capabilities[card_payments][requested]")).toBe("true");
    expect(created[0].form.get("capabilities[transfers][requested]")).toBe("true");
    expect(created[0].headers.get("authorization")).toBe(`Bearer ${SECRET_KEY}`);
    expect(created[0].headers.get("stripe-version")).toBeTruthy();
    expect(created[0].headers.get("content-type")).toContain("application/x-www-form-urlencoded");

    const links = stripe.callsTo("POST", "/v1/account_links");
    expect(links).toHaveLength(2);
    expect(links[0].form.get("type")).toBe("account_onboarding");
    // Stripe wants https in live mode: the links go to this server's return page.
    expect(links[0].form.get("return_url")).toBe("https://lashkirja.example.fi/api/pos/onboarding/return?state=return");
    expect(links[0].form.get("refresh_url")).toBe("https://lashkirja.example.fi/api/pos/onboarding/return?state=refresh");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.stripeAccountId).toMatch(/^acct_/);
    expect(JSON.stringify(body)).not.toContain(SECRET_KEY);
  });

  it("refresh reads the account flags and creates the Terminal location once", async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: { addressStreet: "Ripsikatu 1", addressPostalCode: "00100", addressCity: "Helsinki" },
    });
    await onboarding(buildRequest("POST", "/api/pos/onboarding", {}, { cookie }));
    const account = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).stripeAccountId!;

    const before = await readJson(await refreshOnboarding(buildRequest("POST", "/api/pos/onboarding/refresh", {}, { cookie })));
    expect(before.account).toEqual({ connected: true, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false });
    expect(before.ready).toBe(false);

    stripe.setAccount(account, { charges_enabled: true, payouts_enabled: true, details_submitted: true });
    const after = await readJson(await refreshOnboarding(buildRequest("POST", "/api/pos/onboarding/refresh", {}, { cookie })));
    expect(after.account).toEqual({ connected: true, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
    expect(after.locationId).toMatch(/^tml_/);
    await refreshOnboarding(buildRequest("POST", "/api/pos/onboarding/refresh", {}, { cookie }));

    const locations = stripe.callsTo("POST", "/v1/terminal/locations");
    expect(locations).toHaveLength(1);
    expect(locations[0].headers.get("stripe-account")).toBe(account);
    expect(locations[0].form.get("address[country]")).toBe("FI");
    expect(locations[0].form.get("address[city]")).toBe("Helsinki");
    expect(locations[0].form.get("address[postal_code]")).toBe("00100");
    expect(locations[0].form.get("address[line1]")).toBe("Ripsikatu 1");
  });

  it("enables card payments only while charges are enabled", async () => {
    await onboarding(buildRequest("POST", "/api/pos/onboarding", {}, { cookie }));
    const refused = await posSettings(buildRequest("PATCH", "/api/pos/settings", { posEnabled: true }, { cookie }));
    expect(refused.status).toBe(409);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).posEnabled).toBe(false);

    await connectReadyAccount();
    const status = await readJson(await posStatus(buildRequest("GET", "/api/pos/status", undefined, { cookie })));
    expect(status).toMatchObject({ enabled: true, posEnabled: true, ready: true });
    expect(status.locationId).toMatch(/^tml_/);

    const off = await readJson(await posSettings(buildRequest("PATCH", "/api/pos/settings", { posEnabled: false }, { cookie })));
    expect(off.posEnabled).toBe(false);
    expect(off.ready).toBe(false);
  });

  it("creates the connection token on the connected account", async () => {
    const account = await connectReadyAccount();
    const response = await connectionToken(buildRequest("POST", "/api/pos/connection-token", {}, { cookie }));
    expect(response.status).toBe(200);
    expect((await readJson(response)).secret).toBe(`pst_test_${account}`);
    const call = stripe.callsTo("POST", "/v1/terminal/connection_tokens")[0];
    expect(call.headers.get("stripe-account")).toBe(account);
    expect(call.form.get("location")).toMatch(/^tml_/);
  });

  it("refuses a connection token before the account is ready", async () => {
    const response = await connectionToken(buildRequest("POST", "/api/pos/connection-token", {}, { cookie }));
    expect(response.status).toBe(409);
    expect(stripe.callsTo("POST", "/v1/terminal/connection_tokens")).toHaveLength(0);
  });
});

describe("onboarding return page", () => {
  const visit = (query: string) =>
    onboardingReturn(new NextRequest(`http://localhost:3000/api/pos/onboarding/return${query}`));

  it("redirects state=return and state=refresh to the app's own link, without a session", async () => {
    for (const state of ["return", "refresh"]) {
      const response = visit(`?state=${state}`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`lashkirja://pos/onboarding?state=${state}`);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain("Palaa LashKirjaan");
      expect(html).toContain(`href="lashkirja://pos/onboarding?state=${state}"`);
    }
  });

  it("sends any other state, or none, to state=return: the target is fixed", async () => {
    for (const query of ["?state=https://evil.example", "?state=REFRESH", "", "?next=https://evil.example&state=x"]) {
      const response = visit(query);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("lashkirja://pos/onboarding?state=return");
      expect(await response.text()).not.toContain("evil");
    }
  });

  it("works with Stripe switched off too (it only redirects)", () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(visit("?state=refresh").status).toBe(302);
  });
});

describe("payment intents", () => {
  it("creates a card_present PaymentIntent on the connected account with a namespaced idempotency key", async () => {
    const account = await connectReadyAccount();
    const invoice = await invoiceInState();
    const response = await startPayment(invoice.id, 50.25, "key-1");
    expect(response.status).toBe(201);
    const { payment } = await readJson(response);
    expect(payment).toMatchObject({ amountCents: 5025, currency: "eur" });
    expect(payment.paymentIntentId).toMatch(/^pi_/);
    expect(payment.clientSecret).toContain("_secret_");
    expect(payment.locationId).toMatch(/^tml_/);

    const call = stripe.callsTo("POST", "/v1/payment_intents")[0];
    expect(call.headers.get("stripe-account")).toBe(account);
    expect(call.headers.get("idempotency-key")).toContain("key-1");
    expect(call.headers.get("idempotency-key")).not.toBe("key-1");
    expect(call.form.get("amount")).toBe("5025");
    expect(call.form.get("currency")).toBe("eur");
    expect(call.form.getAll("payment_method_types[]")).toEqual(["card_present"]);
    expect(call.form.get("capture_method")).toBe("automatic");
    expect(call.form.get("metadata[invoiceId]")).toBe(invoice.id);
    expect(call.form.get("metadata[posPaymentId]")).toBe(payment.id);
    expect(call.form.get("metadata[userId]")).toBe(user.id);
    expect(call.form.get("description")).toBe(`Lasku ${invoice.number}`);

    const row = await prisma.posPayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row).toMatchObject({ userId: user.id, invoiceId: invoice.id, amountCents: 5025, status: "created" });
  });

  it("answers the same payment for the same idempotency key", async () => {
    await connectReadyAccount();
    const invoice = await invoiceInState();
    const first = await readJson(await startPayment(invoice.id, 20, "same-key"));
    const second = await startPayment(invoice.id, 20, "same-key");
    expect(second.status).toBe(201);
    expect((await readJson(second)).payment.id).toBe(first.payment.id);
    expect(await prisma.posPayment.count()).toBe(1);
    expect(stripe.callsTo("POST", "/v1/payment_intents")).toHaveLength(1);
  });

  it("refuses an amount above the open amount, zero, and more than two decimals", async () => {
    await connectReadyAccount();
    const invoice = await invoiceInState();
    expect((await startPayment(invoice.id, 125.51)).status).toBe(422);
    expect((await startPayment(invoice.id, 0)).status).toBe(400);
    expect((await startPayment(invoice.id, 1.234)).status).toBe(400);
    expect(stripe.callsTo("POST", "/v1/payment_intents")).toHaveLength(0);
  });

  it("refuses a draft, a credited invoice and a credit note", async () => {
    await connectReadyAccount();
    const draft = await invoiceInState("draft");
    expect((await startPayment(draft.id, 10)).status).toBe(409);
    const credited = await invoiceInState();
    await prisma.salesInvoice.update({ where: { id: credited.id }, data: { status: "credited" } });
    expect((await startPayment(credited.id, 10)).status).toBe(409);
    const note = await invoiceInState();
    await prisma.salesInvoice.update({ where: { id: note.id }, data: { documentKind: "credit_note" } });
    expect((await startPayment(note.id, 10)).status).toBe(409);
    expect(stripe.callsTo("POST", "/v1/payment_intents")).toHaveLength(0);
  });

  it("refuses while this month is locked", async () => {
    await connectReadyAccount();
    const invoice = await invoiceInState();
    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: helsinkiMonthKey() } });
    const response = await startPayment(invoice.id, 10);
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("PERIOD_LOCKED");
  });

  it("does not let one owner charge another owner's invoice", async () => {
    await connectReadyAccount();
    const other = await createUser();
    const otherCookie = await sessionCookie(other);
    const otherCustomer = await readJson(
      await createCustomer(buildRequest("POST", "/api/customers", { name: "Bertta", email: "b@example.fi" }, { cookie: otherCookie }))
    );
    const foreign = await invoiceInState("sent", otherCookie, otherCustomer.customer.id);
    const response = await startPayment(foreign.id, 10);
    expect(response.status).toBe(404);
    expect(stripe.callsTo("POST", "/v1/payment_intents")).toHaveLength(0);
  });
});

describe("finalize", () => {
  async function startedPayment(amount = 125.5) {
    await connectReadyAccount();
    const invoice = await invoiceInState();
    const { payment } = await readJson(await startPayment(invoice.id, amount, `k-${amount}`));
    return { invoice, payment };
  }

  it("books one invoice payment for a succeeded PaymentIntent and marks the invoice paid", async () => {
    const { invoice, payment } = await startedPayment();
    stripe.setIntent(payment.paymentIntentId, "succeeded");
    const response = await finalizeReq(payment.id);
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.payment).toMatchObject({ id: payment.id, invoiceId: invoice.id, status: "succeeded", amount: 125.5, refunded: 0, cardBrand: "visa", cardLast4: "4242" });
    expect(body.payment.succeededAt).toBeTruthy();
    expect(body.invoice.status).toBe("paid");
    expect(body.invoice.open).toBe(0);
    const card = body.invoice.payments.find((row: { source: string }) => row.source === "stripe_terminal");
    expect(card).toMatchObject({ amount: 125.5, posPaymentId: payment.id, paidDate: helsinkiCalendarDate() });

    const retrieve = stripe.callsTo("GET", `/v1/payment_intents/${payment.paymentIntentId}`)[0];
    expect(retrieve.headers.get("stripe-account")).toMatch(/^acct_/);
    expect(await invoicePayments(invoice.id)).toHaveLength(1);
  });

  it("books a partial payment and leaves the rest open", async () => {
    const { invoice, payment } = await startedPayment(25.5);
    stripe.setIntent(payment.paymentIntentId, "succeeded");
    const body = await readJson(await finalizeReq(payment.id));
    expect(body.invoice.status).toBe("sent");
    expect(body.invoice.open).toBe(100);
    expect(await invoicePayments(invoice.id)).toHaveLength(1);
  });

  it("answers 409 with the status while the PaymentIntent is still processing, and books nothing", async () => {
    const { invoice, payment } = await startedPayment();
    stripe.setIntent(payment.paymentIntentId, "processing");
    const response = await finalizeReq(payment.id);
    expect(response.status).toBe(409);
    const body = await readJson(response);
    expect(body.status).toBe("processing");
    expect(typeof body.error).toBe("string");
    expect(await invoicePayments(invoice.id)).toHaveLength(0);

    stripe.setIntent(payment.paymentIntentId, "requires_payment_method");
    const declined = await finalizeReq(payment.id);
    expect(declined.status).toBe(409);
    expect((await readJson(declined)).status).toBe("requires_payment_method");
    expect(await invoicePayments(invoice.id)).toHaveLength(0);
  });

  it("does not trust the client: a payment never confirmed by Stripe is not booked", async () => {
    const { invoice, payment } = await startedPayment();
    const response = await finalizeReq(payment.id);
    expect(response.status).toBe(409);
    expect(await invoicePayments(invoice.id)).toHaveLength(0);
  });

  it("books once however many times finalize runs, also concurrently", async () => {
    const { invoice, payment } = await startedPayment();
    stripe.setIntent(payment.paymentIntentId, "succeeded");
    const results = await Promise.all([finalizeReq(payment.id), finalizeReq(payment.id), finalizeReq(payment.id)]);
    for (const response of results) expect(response.status).toBe(200);
    expect((await finalizeReq(payment.id)).status).toBe(200);
    expect(await invoicePayments(invoice.id)).toHaveLength(1);
    const activity = await prisma.invoiceActivity.count({ where: { invoiceId: invoice.id, kind: "payment_added" } });
    expect(activity).toBe(1);
  });

  it("marks a canceled PaymentIntent canceled", async () => {
    const { invoice, payment } = await startedPayment();
    stripe.setIntent(payment.paymentIntentId, "canceled");
    const response = await finalizeReq(payment.id);
    expect(response.status).toBe(409);
    expect((await readJson(response)).status).toBe("canceled");
    expect((await prisma.posPayment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("canceled");
    expect(await invoicePayments(invoice.id)).toHaveLength(0);
  });

  it("does not finalize another owner's payment", async () => {
    const { payment } = await startedPayment();
    const other = await createUser();
    const response = await finalize(
      buildRequest("POST", `/api/pos/payments/${payment.id}/finalize`, {}, { cookie: await sessionCookie(other) }),
      routeContext({ id: payment.id })
    );
    expect(response.status).toBe(404);
  });

  it("cancels an unpaid PaymentIntent on the connected account", async () => {
    const { payment } = await startedPayment();
    const response = await cancel(
      buildRequest("POST", `/api/pos/payments/${payment.id}/cancel`, {}, { cookie }),
      routeContext({ id: payment.id })
    );
    expect(response.status).toBe(200);
    expect((await readJson(response)).payment.status).toBe("canceled");
    const call = stripe.callsTo("POST", `/v1/payment_intents/${payment.paymentIntentId}/cancel`)[0];
    expect(call.headers.get("stripe-account")).toMatch(/^acct_/);
  });

  it("lists the card payments of an invoice", async () => {
    const { invoice, payment } = await startedPayment();
    const response = await listPayments(buildRequest("GET", `/api/pos/payments?invoiceId=${invoice.id}`, undefined, { cookie }));
    const body = await readJson(response);
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]).toMatchObject({ id: payment.id, invoiceId: invoice.id, status: "created", amount: 125.5, refunded: 0 });
  });
});

describe("webhook", () => {
  async function succeededPayment() {
    const account = await connectReadyAccount();
    const invoice = await invoiceInState();
    const { payment } = await readJson(await startPayment(invoice.id, 125.5, "wh"));
    const intent = stripe.setIntent(payment.paymentIntentId, "succeeded");
    const event = {
      id: "evt_1",
      object: "event",
      type: "payment_intent.succeeded",
      account,
      data: { object: { ...intent, latest_charge: intent.latest_charge } },
    };
    return { account, invoice, payment, event };
  }

  it("books the payment from a verified payment_intent.succeeded, once, also after finalize", async () => {
    const { invoice, payment, event } = await succeededPayment();
    const first = await webhook(webhookRequest(event));
    expect(first.status).toBe(200);
    expect(await invoicePayments(invoice.id)).toHaveLength(1);
    expect((await webhook(webhookRequest(event))).status).toBe(200);
    expect((await finalizeReq(payment.id)).status).toBe(200);
    expect(await invoicePayments(invoice.id)).toHaveLength(1);
    expect((await openInvoice(invoice.id)).status).toBe("paid");
  });

  it("is safe when finalize and the webhook arrive together", async () => {
    const { invoice, payment, event } = await succeededPayment();
    const [a, b] = await Promise.all([finalizeReq(payment.id), webhook(webhookRequest(event))]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await invoicePayments(invoice.id)).toHaveLength(1);
  });

  it("refuses a bad signature, a wrong secret and a stale timestamp", async () => {
    const { invoice, event } = await succeededPayment();
    expect((await webhook(webhookRequest(event, { secret: "whsec_wrong" }))).status).toBe(400);
    expect((await webhook(webhookRequest(event, { signature: "t=1,v1=deadbeef" }))).status).toBe(400);
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    expect((await webhook(webhookRequest(event, { timestamp: stale }))).status).toBe(400);
    const noHeader = new NextRequest(new URL("/api/stripe/webhook", "http://localhost:3000"), {
      method: "POST",
      body: JSON.stringify(event),
    });
    expect((await webhook(noHeader)).status).toBe(400);
    expect(await invoicePayments(invoice.id)).toHaveLength(0);
  });

  it("updates the account flags on account.updated", async () => {
    const account = await connectReadyAccount();
    const event = {
      id: "evt_2",
      object: "event",
      type: "account.updated",
      account,
      data: { object: { id: account, object: "account", charges_enabled: false, payouts_enabled: false, details_submitted: true } },
    };
    expect((await webhook(webhookRequest(event))).status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.stripeChargesEnabled).toBe(false);
    expect(row.stripePayoutsEnabled).toBe(false);
    const status = await readJson(await posStatus(buildRequest("GET", "/api/pos/status", undefined, { cookie })));
    expect(status.ready).toBe(false);
  });

  it("marks a failed payment failed", async () => {
    const account = await connectReadyAccount();
    const invoice = await invoiceInState();
    const { payment } = await readJson(await startPayment(invoice.id, 10, "fail"));
    const intent = stripe.setIntent(payment.paymentIntentId, "requires_payment_method");
    const event = { id: "evt_3", object: "event", type: "payment_intent.payment_failed", account, data: { object: intent } };
    expect((await webhook(webhookRequest(event))).status).toBe(200);
    const row = await prisma.posPayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe("failed");
    expect(row.failureCode).toBe("card_declined");
  });

  it("answers 503 when the webhook secret is not configured", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const response = await webhook(webhookRequest({ id: "evt", type: "account.updated", data: { object: {} } }));
    expect(response.status).toBe(503);
  });
});

describe("refund", () => {
  async function bookedPayment() {
    await connectReadyAccount();
    const invoice = await invoiceInState();
    const { payment } = await readJson(await startPayment(invoice.id, 125.5, "rf"));
    stripe.setIntent(payment.paymentIntentId, "succeeded");
    expect((await finalizeReq(payment.id)).status).toBe(200);
    return { invoice, payment };
  }

  const refundReq = (id: string, body: Record<string, unknown> = {}) =>
    refund(buildRequest("POST", `/api/pos/payments/${id}/refund`, body, { cookie }), routeContext({ id }));

  it("a partial refund reduces the invoice payment and reopens the invoice", async () => {
    const { invoice, payment } = await bookedPayment();
    const response = await refundReq(payment.id, { amount: 25.5 });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.payment).toMatchObject({ status: "partially_refunded", refunded: 25.5 });
    expect(body.invoice.status).toBe("sent");
    expect(body.invoice.open).toBe(25.5);
    const rows = await invoicePayments(invoice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCents).toBe(10_000);
    const call = stripe.callsTo("POST", "/v1/refunds")[0];
    expect(call.headers.get("stripe-account")).toMatch(/^acct_/);
    expect(call.headers.get("idempotency-key")).toBeTruthy();
    expect(call.form.get("amount")).toBe("2550");
    expect(call.form.get("payment_intent")).toBe(payment.paymentIntentId);
    const activity = await prisma.invoiceActivity.findMany({ where: { invoiceId: invoice.id, kind: "pos_refund" } });
    expect(activity[0]?.summary).toContain("Korttimaksu palautettu");
  });

  it("a full refund removes the invoice payment; a later charge.refunded webhook changes nothing more", async () => {
    const { invoice, payment } = await bookedPayment();
    const body = await readJson(await refundReq(payment.id));
    expect(body.payment).toMatchObject({ status: "refunded", refunded: 125.5 });
    expect(body.invoice.open).toBe(125.5);
    expect(await invoicePayments(invoice.id)).toHaveLength(0);

    const intent = stripe.intents.get(payment.paymentIntentId)!;
    const charge = stripe.charges.get(intent.latest_charge!)!;
    const account = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).stripeAccountId!;
    const event = { id: "evt_r", object: "event", type: "charge.refunded", account, data: { object: charge } };
    expect((await webhook(webhookRequest(event))).status).toBe(200);
    expect((await finalizeReq(payment.id)).status).toBe(200);
    expect(await invoicePayments(invoice.id)).toHaveLength(0);
    expect((await prisma.posPayment.findUniqueOrThrow({ where: { id: payment.id } })).refundedCents).toBe(12_550);
  });

  it("a refund made in the Stripe Dashboard is booked from charge.refunded", async () => {
    const { invoice, payment } = await bookedPayment();
    const intent = stripe.intents.get(payment.paymentIntentId)!;
    const charge = stripe.charges.get(intent.latest_charge!)!;
    charge.amount_refunded = 5_050;
    const account = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).stripeAccountId!;
    const event = { id: "evt_d", object: "event", type: "charge.refunded", account, data: { object: charge } };
    expect((await webhook(webhookRequest(event))).status).toBe(200);
    expect((await webhook(webhookRequest(event))).status).toBe(200);
    const rows = await invoicePayments(invoice.id);
    expect(rows[0].amountCents).toBe(7_500);
    expect((await openInvoice(invoice.id)).open).toBe(50.5);
  });

  it("refuses a refund larger than what is left", async () => {
    const { payment } = await bookedPayment();
    expect((await refundReq(payment.id, { amount: 200 })).status).toBe(422);
    expect(stripe.callsTo("POST", "/v1/refunds")).toHaveLength(0);
  });

  it("the card payment cannot be deleted from the invoice", async () => {
    const { invoice } = await bookedPayment();
    const [row] = await invoicePayments(invoice.id);
    const response = await deletePayment(
      buildRequest("DELETE", `/api/invoices/${invoice.id}/payments?paymentId=${row.id}`, undefined, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error).toBe("Korttimaksua ei voi poistaa. Palauta maksu.");
    expect(await invoicePayments(invoice.id)).toHaveLength(1);
  });

  it("a hand-recorded payment still works next to a card payment", async () => {
    await connectReadyAccount();
    const invoice = await invoiceInState();
    const manual = await addPayment(
      buildRequest("POST", `/api/invoices/${invoice.id}/payments`, { amount: 25.5, paidDate: "2026-01-20" }, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(manual.status).toBe(201);
    const { payment } = await readJson(await startPayment(invoice.id, 100, "mix"));
    stripe.setIntent(payment.paymentIntentId, "succeeded");
    const body = await readJson(await finalizeReq(payment.id));
    expect(body.invoice.status).toBe("paid");
    const manualRow = body.invoice.payments.find((row: { source: string }) => row.source === "manual");
    expect(manualRow.posPaymentId).toBeNull();
  });
});

describe("account data", () => {
  it("the data copy carries korttimaksut.json", async () => {
    await connectReadyAccount();
    const invoice = await invoiceInState();
    await startPayment(invoice.id, 10, "copy");
    const zip = await buildAccountCopyZip(user.id);
    expect(zip.includes(Buffer.from("korttimaksut.json"))).toBe(true);
  });

  it("closing the account switches card payments off", async () => {
    await connectReadyAccount();
    const request = await prisma.accountRequest.create({ data: { userId: user.id, kind: "close" } });
    await completeAccountClose(request.id);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.posEnabled).toBe(false);
  });
});

describe("Stripe errors", () => {
  it("maps a Stripe failure to a Finnish message without Stripe internals", async () => {
    await connectReadyAccount();
    const invoice = await invoiceInState();
    stripe.failNext(400, { type: "invalid_request_error", code: "parameter_invalid", message: "Internal detail req_123 sk_live" });
    const response = await startPayment(invoice.id, 10, "err");
    expect(response.status).toBeGreaterThanOrEqual(400);
    const text = JSON.stringify(await readJson(response));
    expect(text).not.toContain("req_123");
    expect(text).not.toContain("Internal detail");
    expect(await prisma.posPayment.count()).toBe(0);
  });
});
