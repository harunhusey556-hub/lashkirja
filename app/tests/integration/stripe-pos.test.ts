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
import { POST as acceptCorrection } from "@/app/api/pos/corrections/[id]/accept/route";
import { GET as workQueue } from "@/app/api/work-queue/route";
import { buildAccountCopyZip, completeAccountClose } from "@/lib/account-requests";
import { readStoredZip } from "@/lib/zip-store";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";
import { installFakeStripe, stripeSignature, type FakeStripe } from "./helpers/fake-stripe";

// A live-looking key by default: only a live key with a livemode PaymentIntent
// books a card payment. The test-mode tests switch to TEST_KEY.
const SECRET_KEY = "sk_live_integration_key_never_logged";
const TEST_KEY = "sk_test_integration_key_never_logged";
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
    for (const key of [TEST_KEY, "rk_test_restricted_integration_key"]) {
      process.env.STRIPE_SECRET_KEY = key;
      const response = await posStatus(buildRequest("GET", "/api/pos/status", undefined, { cookie }));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ enabled: true, testMode: true });
      expect(text).not.toContain(key);
    }
    for (const key of [SECRET_KEY, "rk_live_restricted_integration_key", "sk_testlike"]) {
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
    expect(body.payment).toMatchObject({ id: payment.id, invoiceId: invoice.id, status: "succeeded", amount: 125.5, refunded: 0, cardBrand: "visa", cardLast4: "4242", livemode: true });
    expect(body.payment.succeededAt).toBeTruthy();
    expect(body).toMatchObject({ booked: true, testPayment: false });
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

  let refundKeys = 0;
  const refundReq = (id: string, body: Record<string, unknown> = {}, key: string | null = `refund-${++refundKeys}`) =>
    refund(
      buildRequest("POST", `/api/pos/payments/${id}/refund`, body, {
        cookie,
        headers: key ? { "idempotency-key": key } : {},
      }),
      routeContext({ id })
    );

  it("needs an Idempotency-Key, so a retried refund can never be a second one", async () => {
    const { payment } = await bookedPayment();
    expect((await refundReq(payment.id, { amount: 10 }, null)).status).toBe(400);
    expect(stripe.callsTo("POST", "/v1/refunds")).toHaveLength(0);
  });

  it("a retry with the same key after the refund was booked refunds nothing more", async () => {
    const { invoice, payment } = await bookedPayment();
    expect((await refundReq(payment.id, { amount: 25.5 }, "same-key")).status).toBe(200);
    const again = await refundReq(payment.id, { amount: 25.5 }, "same-key");
    expect(again.status).toBe(200);
    expect((await readJson(again)).payment).toMatchObject({ refunded: 25.5 });
    expect(stripe.callsTo("POST", "/v1/refunds")).toHaveLength(1);
    expect((await invoicePayments(invoice.id))[0].amountCents).toBe(10_000);
  });

  it("a refund whose answer was lost is not repeated after a webhook moved the total", async () => {
    const { invoice, payment } = await bookedPayment();
    // The first try reaches Stripe, but the answer never reaches the server: nothing is stored.
    const pos = await prisma.posPayment.findUniqueOrThrow({ where: { id: payment.id } });
    const account = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).stripeAccountId!;
    const { refundPosPayment } = await import("@/lib/pos-payments");
    await refundPosPayment(user.id, payment.id, 25.5, "lost-answer");
    await prisma.posPayment.update({ where: { id: pos.id }, data: { refundedCents: pos.refundedCents, status: pos.status } });
    // Meanwhile Stripe's charge.refunded books the 25,50 € that really went out.
    const intent = stripe.intents.get(payment.paymentIntentId)!;
    const charge = stripe.charges.get(intent.latest_charge!)!;
    const event = { id: "evt_lost", object: "event", type: "charge.refunded", account, data: { object: charge } };
    expect((await webhook(webhookRequest(event))).status).toBe(200);
    // The app retries with the same key: Stripe answers the same refund, the total stays 25,50 €.
    const retry = await refundReq(payment.id, { amount: 25.5 }, "lost-answer");
    expect(retry.status).toBe(200);
    expect(new Set(stripe.callsTo("POST", "/v1/refunds").map((c) => c.headers.get("idempotency-key"))).size).toBe(1);
    expect(stripe.charges.get(intent.latest_charge!)!.amount_refunded).toBe(2_550);
    expect((await prisma.posPayment.findUniqueOrThrow({ where: { id: payment.id } })).refundedCents).toBe(2_550);
    expect((await invoicePayments(invoice.id))[0].amountCents).toBe(10_000);
  });

  it("books the refunded total Stripe reports, not a sum kept by the server", async () => {
    const { payment } = await bookedPayment();
    // A Dashboard refund the server has not heard of yet.
    const intent = stripe.intents.get(payment.paymentIntentId)!;
    stripe.charges.get(intent.latest_charge!)!.amount_refunded = 1_000;
    const body = await readJson(await refundReq(payment.id, { amount: 25.5 }));
    expect(body.payment.refunded).toBe(35.5);
  });

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

describe("test mode: a Stripe test payment never reaches the books", () => {
  async function paidTestPayment(key = TEST_KEY, forceLivemode: boolean | null = null) {
    process.env.STRIPE_SECRET_KEY = key;
    stripe.forceLivemode = forceLivemode;
    const account = await connectReadyAccount();
    const invoice = await invoiceInState();
    const { payment } = await readJson(await startPayment(invoice.id, 125.5, `tm-${key}-${forceLivemode}`));
    stripe.setIntent(payment.paymentIntentId, "succeeded");
    return { account, invoice, payment };
  }

  async function expectBooksUntouched(invoiceId: string) {
    expect(await invoicePayments(invoiceId)).toHaveLength(0);
    const invoice = await openInvoice(invoiceId);
    expect(invoice.status).toBe("sent");
    expect(invoice.open).toBe(125.5);
    expect(invoice.payments).toEqual([]);
    const activity = await prisma.invoiceActivity.count({
      where: { invoiceId, kind: { in: ["payment_added", "pos_refund"] } },
    });
    expect(activity).toBe(0);
  }

  it("finalize of a test PaymentIntent (livemode false) marks it succeeded and books nothing", async () => {
    const { invoice, payment } = await paidTestPayment();
    expect(stripe.intents.get(payment.paymentIntentId)!.livemode).toBe(false);
    const response = await finalizeReq(payment.id);
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({ booked: false, testPayment: true });
    expect(body.payment).toMatchObject({ id: payment.id, status: "succeeded", livemode: false, amount: 125.5 });
    expect(body.payment.succeededAt).toBeTruthy();
    expect(body.invoice.status).toBe("sent");
    await expectBooksUntouched(invoice.id);
    const row = await prisma.posPayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row).toMatchObject({ livemode: false, status: "succeeded" });
    // Running it again still books nothing.
    expect((await finalizeReq(payment.id)).status).toBe(200);
    await expectBooksUntouched(invoice.id);
  });

  it("stores the PaymentIntent's livemode when the payment is created", async () => {
    process.env.STRIPE_SECRET_KEY = TEST_KEY;
    await connectReadyAccount();
    const testInvoice = await invoiceInState();
    const { payment: test } = await readJson(await startPayment(testInvoice.id, 10, "lm-test"));
    expect((await prisma.posPayment.findUniqueOrThrow({ where: { id: test.id } })).livemode).toBe(false);

    process.env.STRIPE_SECRET_KEY = SECRET_KEY;
    const liveInvoice = await invoiceInState();
    const { payment: live } = await readJson(await startPayment(liveInvoice.id, 10, "lm-live"));
    expect((await prisma.posPayment.findUniqueOrThrow({ where: { id: live.id } })).livemode).toBe(true);
  });

  it("a live key with a test PaymentIntent is not booked", async () => {
    const { invoice, payment } = await paidTestPayment(SECRET_KEY, false);
    const body = await readJson(await finalizeReq(payment.id));
    expect(body).toMatchObject({ booked: false, testPayment: true });
    expect(body.payment.livemode).toBe(false);
    await expectBooksUntouched(invoice.id);
  });

  it("a test key with a PaymentIntent that says livemode true is not booked", async () => {
    const { invoice, payment } = await paidTestPayment(TEST_KEY, true);
    const body = await readJson(await finalizeReq(payment.id));
    expect(body).toMatchObject({ booked: false, testPayment: true });
    await expectBooksUntouched(invoice.id);
  });

  it("a key that is neither sk_live_ nor rk_live_ counts as test", async () => {
    const { invoice, payment } = await paidTestPayment("sk_testlike_unknown_prefix", true);
    const body = await readJson(await finalizeReq(payment.id));
    expect(body).toMatchObject({ booked: false, testPayment: true });
    await expectBooksUntouched(invoice.id);
  });

  it("livemode is re-checked from the retrieved PaymentIntent at finalize", async () => {
    const { invoice, payment } = await paidTestPayment(SECRET_KEY);
    // Stored as live at creation; Stripe now answers livemode false.
    expect((await prisma.posPayment.findUniqueOrThrow({ where: { id: payment.id } })).livemode).toBe(true);
    stripe.intents.get(payment.paymentIntentId)!.livemode = false;
    const body = await readJson(await finalizeReq(payment.id));
    expect(body).toMatchObject({ booked: false, testPayment: true });
    expect((await prisma.posPayment.findUniqueOrThrow({ where: { id: payment.id } })).livemode).toBe(false);
    await expectBooksUntouched(invoice.id);
  });

  it("a verified payment_intent.succeeded for a test payment books nothing", async () => {
    const { account, invoice, payment } = await paidTestPayment();
    const intent = stripe.intents.get(payment.paymentIntentId)!;
    const event = { id: "evt_t", object: "event", type: "payment_intent.succeeded", livemode: false, account, data: { object: intent } };
    expect((await webhook(webhookRequest(event))).status).toBe(200);
    expect((await webhook(webhookRequest(event))).status).toBe(200);
    expect((await prisma.posPayment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("succeeded");
    await expectBooksUntouched(invoice.id);
  });

  it("refunding a test payment calls Stripe but leaves the invoice alone", async () => {
    const { invoice, payment } = await paidTestPayment();
    expect((await finalizeReq(payment.id)).status).toBe(200);
    const response = await refund(
      buildRequest("POST", `/api/pos/payments/${payment.id}/refund`, { amount: 25.5 }, { cookie, headers: { "idempotency-key": "tm-refund" } }),
      routeContext({ id: payment.id })
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({ booked: false, testPayment: true });
    expect(body.payment).toMatchObject({ status: "partially_refunded", refunded: 25.5, livemode: false });
    const call = stripe.callsTo("POST", "/v1/refunds");
    expect(call).toHaveLength(1);
    expect(call[0].form.get("amount")).toBe("2550");
    await expectBooksUntouched(invoice.id);
  });

  it("charge.refunded for a test payment only updates the card payment", async () => {
    const { account, invoice, payment } = await paidTestPayment();
    expect((await finalizeReq(payment.id)).status).toBe(200);
    const intent = stripe.intents.get(payment.paymentIntentId)!;
    const charge = stripe.charges.get(intent.latest_charge!)!;
    charge.amount_refunded = 12_550;
    const event = { id: "evt_tr", object: "event", type: "charge.refunded", livemode: false, account, data: { object: charge } };
    expect((await webhook(webhookRequest(event))).status).toBe(200);
    const row = await prisma.posPayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row).toMatchObject({ refundedCents: 12_550, status: "refunded" });
    await expectBooksUntouched(invoice.id);
  });

  it("a test payment is labelled in the data copy", async () => {
    const { payment } = await paidTestPayment();
    expect((await finalizeReq(payment.id)).status).toBe(200);
    const files = readStoredZip(await buildAccountCopyZip(user.id));
    const rows = JSON.parse(files.get("korttimaksut.json")!.toString("utf8"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: payment.id,
      livemode: false,
      testimaksu: true,
      huomautus: "Stripen testimaksu – ei kirjattu laskulle.",
    });
    const { listPosPayments } = await import("@/lib/pos-payments");
    expect((await listPosPayments(user.id))[0]).toMatchObject({ id: payment.id, livemode: false });
  });
});

describe("refund in a locked month: the closed month is never changed", () => {
  /** "YYYY-MM" shifted by whole months. */
  function shiftMonth(month: string, by: number): string {
    const [year, mon] = month.split("-").map(Number);
    const date = new Date(Date.UTC(year, mon - 1 + by, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  async function bookedLive(amount = 125.5, key = "lk") {
    const account = await connectReadyAccount();
    const invoice = await invoiceInState();
    const { payment } = await readJson(await startPayment(invoice.id, amount, key));
    stripe.setIntent(payment.paymentIntentId, "succeeded");
    expect((await finalizeReq(payment.id)).status).toBe(200);
    return { account, invoice, payment };
  }

  const lockThrough = (month: string) =>
    prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: month } });

  let keys = 0;
  const refundReq = (id: string, body: Record<string, unknown> = {}, key = `locked-${++keys}`) =>
    refund(
      buildRequest("POST", `/api/pos/payments/${id}/refund`, body, { cookie, headers: { "idempotency-key": key } }),
      routeContext({ id })
    );

  const accept = (id: string, as = cookie) =>
    acceptCorrection(buildRequest("POST", `/api/pos/corrections/${id}/accept`, {}, { cookie: as }), routeContext({ id }));

  async function cards() {
    const body = await readJson(await workQueue(buildRequest("GET", "/api/work-queue", undefined, { cookie })));
    return (body.items as Array<{ kind: string; correctionId?: string; detail: string; href: string | null }>).filter(
      (item) => item.kind === "card_refund_correction"
    );
  }

  const posRefunds = (posPaymentId: string) =>
    prisma.posRefund.findMany({ where: { posPaymentId }, orderBy: { createdAt: "asc" } });

  function chargedRefundEvent(account: string, paymentIntentId: string, id = "evt_lock") {
    const intent = stripe.intents.get(paymentIntentId)!;
    const charge = stripe.charges.get(intent.latest_charge!)!;
    return { id, object: "event", type: "charge.refunded", livemode: true, account, data: { object: { ...charge } } };
  }

  it("refunds at Stripe, marks the card payment refunded, leaves the locked month alone and adds one card", async () => {
    const { invoice, payment } = await bookedLive();
    await lockThrough(helsinkiMonthKey());
    const response = await refundReq(payment.id, { amount: 25.5 });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.payment).toMatchObject({ status: "partially_refunded", refunded: 25.5 });
    expect(body).toMatchObject({ booked: true, testPayment: false, correctionPending: true });
    expect(stripe.callsTo("POST", "/v1/refunds")).toHaveLength(1);

    const rows = await invoicePayments(invoice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCents).toBe(12_550);
    expect((await openInvoice(invoice.id)).status).toBe("paid");

    const refunds = await posRefunds(payment.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ amountCents: 2_550, books: "correction_pending" });
    expect(refunds[0].stripeRefundId).toMatch(/^re_/);
    const queue = await cards();
    expect(queue).toHaveLength(1);
    expect(queue[0].correctionId).toBe(refunds[0].id);
    expect(queue[0].detail).toContain("25,50");
    expect(queue[0].href).toContain(invoice.id);
    const activity = await prisma.invoiceActivity.findMany({ where: { invoiceId: invoice.id, kind: "pos_refund" } });
    expect(activity).toHaveLength(1);
    expect(activity[0].summary).toContain("korjaus odottaa hyväksyntää");
  });

  it("accepting posts the correction once, in the first open month", async () => {
    const { invoice, payment } = await bookedLive();
    const month = helsinkiMonthKey();
    await lockThrough(month);
    expect((await refundReq(payment.id, { amount: 25.5 })).status).toBe(200);
    const [card] = await cards();

    const response = await accept(card.correctionId!);
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.invoice.status).toBe("sent");
    expect(body.invoice.open).toBe(25.5);

    const rows = await invoicePayments(invoice.id);
    expect(rows).toHaveLength(2);
    const correction = rows.find((row) => row.amountCents < 0)!;
    expect(correction.amountCents).toBe(-2_550);
    expect(correction.source).toBe("stripe_terminal");
    expect(correction.posPaymentId).toBeNull();
    // The month is locked through this month: the first open day is the 1st of next month.
    expect(correction.paidDate.toISOString().slice(0, 10)).toBe(`${shiftMonth(month, 1)}-01`);
    expect(rows.find((row) => row.amountCents > 0)!.amountCents).toBe(12_550);

    const refunds = await posRefunds(payment.id);
    expect(refunds[0]).toMatchObject({ books: "corrected", correctionPaymentId: correction.id });
    expect(await cards()).toHaveLength(0);

    // A repeated accept changes nothing.
    expect((await accept(card.correctionId!)).status).toBe(200);
    expect(await invoicePayments(invoice.id)).toHaveLength(2);
  });

  it("dates the correction on the refund day when that month is open", async () => {
    const { invoice, payment } = await bookedLive();
    // The payment was in last month, which is now locked; this month is open.
    const lastMonth = shiftMonth(helsinkiMonthKey(), -1);
    await prisma.invoicePayment.updateMany({ where: { posPaymentId: payment.id }, data: { paidDate: new Date(`${lastMonth}-15T00:00:00.000Z`) } });
    await lockThrough(lastMonth);
    expect((await refundReq(payment.id, { amount: 25.5 })).status).toBe(200);
    const [card] = await cards();
    expect((await accept(card.correctionId!)).status).toBe(200);
    const correction = (await invoicePayments(invoice.id)).find((row) => row.amountCents < 0)!;
    expect(correction.paidDate.toISOString().slice(0, 10)).toBe(helsinkiCalendarDate());
  });

  it("the app refund, its retry and the webhook make one card and one correction", async () => {
    const { account, invoice, payment } = await bookedLive();
    await lockThrough(helsinkiMonthKey());
    expect((await refundReq(payment.id, { amount: 25.5 }, "same-refund")).status).toBe(200);
    expect((await refundReq(payment.id, { amount: 25.5 }, "same-refund")).status).toBe(200);
    const event = chargedRefundEvent(account, payment.paymentIntentId);
    expect((await webhook(webhookRequest(event))).status).toBe(200);
    expect((await webhook(webhookRequest(event))).status).toBe(200);
    expect(stripe.callsTo("POST", "/v1/refunds")).toHaveLength(1);
    expect(await posRefunds(payment.id)).toHaveLength(1);
    const queue = await cards();
    expect(queue).toHaveLength(1);
    await Promise.all([accept(queue[0].correctionId!), accept(queue[0].correctionId!)]);
    expect((await invoicePayments(invoice.id)).filter((row) => row.amountCents < 0)).toHaveLength(1);
  });

  it("two partial refunds are two cards with their own amounts", async () => {
    const { invoice, payment } = await bookedLive();
    await lockThrough(helsinkiMonthKey());
    expect((await refundReq(payment.id, { amount: 25.5 })).status).toBe(200);
    expect((await refundReq(payment.id, { amount: 10 })).status).toBe(200);
    const refunds = await posRefunds(payment.id);
    expect(refunds.map((row) => row.amountCents).sort((a, b) => a - b)).toEqual([1_000, 2_550]);
    const queue = await cards();
    expect(queue).toHaveLength(2);
    for (const card of queue) expect((await accept(card.correctionId!)).status).toBe(200);
    const corrections = (await invoicePayments(invoice.id)).filter((row) => row.amountCents < 0);
    expect(corrections.map((row) => row.amountCents).sort((a, b) => a - b)).toEqual([-2_550, -1_000]);
    expect((await openInvoice(invoice.id)).open).toBe(35.5);
    expect((await prisma.posPayment.findUniqueOrThrow({ where: { id: payment.id } })).refundedCents).toBe(3_550);
  });

  it("a Stripe Dashboard refund in a locked month becomes a card from the webhook", async () => {
    const { account, invoice, payment } = await bookedLive();
    await lockThrough(helsinkiMonthKey());
    stripe.dashboardRefund(payment.paymentIntentId, 5_050);
    expect((await webhook(webhookRequest(chargedRefundEvent(account, payment.paymentIntentId)))).status).toBe(200);
    expect((await prisma.posPayment.findUniqueOrThrow({ where: { id: payment.id } })).refundedCents).toBe(5_050);
    expect((await invoicePayments(invoice.id))[0].amountCents).toBe(12_550);
    const queue = await cards();
    expect(queue).toHaveLength(1);
    expect(queue[0].detail).toContain("50,50");
    const listed = stripe.callsTo("GET", "/v1/refunds");
    expect(listed[0].headers.get("stripe-account")).toBe(account);
  });

  it("a refund in an open month works as before and leaves no card, even if the month is locked later", async () => {
    const { account, invoice, payment } = await bookedLive();
    expect((await refundReq(payment.id, { amount: 25.5 })).status).toBe(200);
    expect((await invoicePayments(invoice.id))[0].amountCents).toBe(10_000);
    expect(await posRefunds(payment.id)).toEqual([expect.objectContaining({ amountCents: 2_550, books: "applied" })]);
    await lockThrough(helsinkiMonthKey());
    expect((await webhook(webhookRequest(chargedRefundEvent(account, payment.paymentIntentId)))).status).toBe(200);
    expect(await cards()).toHaveLength(0);
    expect((await invoicePayments(invoice.id))[0].amountCents).toBe(10_000);
  });

  it("a test payment never gets a card", async () => {
    process.env.STRIPE_SECRET_KEY = TEST_KEY;
    const { account, invoice, payment } = await bookedLive();
    await lockThrough(helsinkiMonthKey());
    const response = await refundReq(payment.id, { amount: 25.5 });
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ testPayment: true, correctionPending: false });
    expect((await webhook(webhookRequest(chargedRefundEvent(account, payment.paymentIntentId)))).status).toBe(200);
    expect(await cards()).toHaveLength(0);
    expect(await prisma.posRefund.count()).toBe(0);
    expect(await invoicePayments(invoice.id)).toHaveLength(0);
  });

  it("only the owner can accept, and a correction cannot be removed by hand", async () => {
    const { invoice, payment } = await bookedLive();
    await lockThrough(helsinkiMonthKey());
    expect((await refundReq(payment.id, { amount: 25.5 })).status).toBe(200);
    const [card] = await cards();
    const other = await createUser();
    expect((await accept(card.correctionId!, await sessionCookie(other))).status).toBe(404);
    expect((await invoicePayments(invoice.id)).filter((row) => row.amountCents < 0)).toHaveLength(0);

    expect((await accept(card.correctionId!)).status).toBe(200);
    const correction = (await invoicePayments(invoice.id)).find((row) => row.amountCents < 0)!;
    const removed = await deletePayment(
      buildRequest("DELETE", `/api/invoices/${invoice.id}/payments?paymentId=${correction.id}`, undefined, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(removed.status).toBe(409);
  });
});

describe("reconcile: the worker's safety net for payments the app and webhook missed", () => {
  const MINUTE = 60_000;
  const DAY = 24 * 60 * MINUTE;

  async function reconcile(options: Record<string, number> = {}) {
    const { reconcilePosPayments } = await import("@/lib/pos-payments");
    return reconcilePosPayments(options);
  }

  /** A started card payment, back-dated as if the app went away after the tap. */
  async function strandedPayment(amount = 10, ageMs = 30 * MINUTE, key?: string) {
    const invoice = await invoiceInState();
    const { payment } = await readJson(await startPayment(invoice.id, amount, key ?? `st-${invoice.id}`));
    await prisma.posPayment.update({
      where: { id: payment.id },
      data: { createdAt: new Date(Date.now() - ageMs), status: "processing" },
    });
    return { invoice, payment };
  }

  const reads = () => stripe.callsTo("GET", "/v1/payment_intents/");

  it("books an old payment that succeeded at Stripe, once, through the finalize path", async () => {
    await connectReadyAccount();
    const { invoice, payment } = await strandedPayment(125.5);
    stripe.setIntent(payment.paymentIntentId, "succeeded");
    const first = await reconcile();
    expect(first).toMatchObject({ checked: 1, succeeded: 1, booked: 1, testPayments: 0, errors: 0 });
    const rows = await invoicePayments(invoice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "stripe_terminal", posPaymentId: payment.id, amountCents: 12_550 });
    expect((await openInvoice(invoice.id)).status).toBe("paid");
    expect(reads()[0].headers.get("stripe-account")).toMatch(/^acct_/);

    // The next cycle does not even ask again: the payment is settled.
    const second = await reconcile();
    expect(second.checked).toBe(0);
    expect(await invoicePayments(invoice.id)).toHaveLength(1);
    expect((await finalizeReq(payment.id)).status).toBe(200);
    expect(await invoicePayments(invoice.id)).toHaveLength(1);
  });

  it("a test-mode payment is marked succeeded but never booked", async () => {
    process.env.STRIPE_SECRET_KEY = TEST_KEY;
    await connectReadyAccount();
    const { invoice, payment } = await strandedPayment(125.5);
    stripe.setIntent(payment.paymentIntentId, "succeeded");
    expect(await reconcile()).toMatchObject({ checked: 1, succeeded: 1, booked: 0, testPayments: 1 });
    expect((await prisma.posPayment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("succeeded");
    expect(await invoicePayments(invoice.id)).toHaveLength(0);
    expect((await openInvoice(invoice.id)).status).toBe("sent");
  });

  it("skips payments younger than 10 minutes and older than 7 days", async () => {
    await connectReadyAccount();
    const young = await strandedPayment(10, 2 * MINUTE);
    const old = await strandedPayment(10, 8 * DAY);
    stripe.setIntent(young.payment.paymentIntentId, "succeeded");
    stripe.setIntent(old.payment.paymentIntentId, "succeeded");
    expect(await reconcile()).toMatchObject({ checked: 0 });
    expect(reads()).toHaveLength(0);
    expect(await invoicePayments(young.invoice.id)).toHaveLength(0);
    expect(await invoicePayments(old.invoice.id)).toHaveLength(0);
  });

  it("respects the per-cycle cap and the per-owner cap, oldest first", async () => {
    await connectReadyAccount();
    const stranded = [];
    for (let index = 0; index < 7; index += 1) {
      stranded.push(await strandedPayment(10, (60 - index) * MINUTE));
    }
    for (const { payment } of stranded) stripe.setIntent(payment.paymentIntentId, "succeeded");

    const capped = await reconcile({ maxReads: 3 });
    expect(capped.checked).toBe(3);
    expect(reads()).toHaveLength(3);
    // Oldest first: the three oldest are the first three created.
    for (const { invoice } of stranded.slice(0, 3)) expect(await invoicePayments(invoice.id)).toHaveLength(1);
    for (const { invoice } of stranded.slice(3)) expect(await invoicePayments(invoice.id)).toHaveLength(0);

    const perOwner = await reconcile({ maxReads: 20, maxReadsPerOwner: 2 });
    expect(perOwner.checked).toBe(2);
    const defaults = await reconcile();
    expect(defaults.checked).toBe(2);
    expect(reads()).toHaveLength(7);
  });

  it("the default caps are 20 per cycle and 5 per owner", async () => {
    await connectReadyAccount();
    for (let index = 0; index < 6; index += 1) {
      const { payment } = await strandedPayment(10, (30 + index) * MINUTE);
      stripe.setIntent(payment.paymentIntentId, "processing");
    }
    expect((await reconcile()).checked).toBe(5);
  });

  it("racing finalize books exactly one invoice payment", async () => {
    await connectReadyAccount();
    const { invoice, payment } = await strandedPayment(125.5);
    stripe.setIntent(payment.paymentIntentId, "succeeded");
    const [summary, finalized] = await Promise.all([reconcile(), finalizeReq(payment.id), reconcile()]);
    expect(finalized.status).toBe(200);
    expect(summary.errors).toBe(0);
    expect(await invoicePayments(invoice.id)).toHaveLength(1);
    expect(await prisma.invoiceActivity.count({ where: { invoiceId: invoice.id, kind: "payment_added" } })).toBe(1);
  });

  it("marks a payment canceled at Stripe canceled, and leaves one still processing", async () => {
    await connectReadyAccount();
    const canceled = await strandedPayment(10);
    const processing = await strandedPayment(10);
    stripe.setIntent(canceled.payment.paymentIntentId, "canceled");
    stripe.setIntent(processing.payment.paymentIntentId, "processing");
    expect(await reconcile()).toMatchObject({ checked: 2, canceled: 1, pending: 1, booked: 0 });
    expect((await prisma.posPayment.findUniqueOrThrow({ where: { id: canceled.payment.id } })).status).toBe("canceled");
    expect((await prisma.posPayment.findUniqueOrThrow({ where: { id: processing.payment.id } })).status).toBe("processing");
    // It never cancels, creates or confirms anything at Stripe.
    expect(stripe.calls.filter((call) => call.method === "POST" && call.path.startsWith("/v1/payment_intents"))).toHaveLength(2);
  });

  it("a Stripe error on one payment does not stop the others", async () => {
    await connectReadyAccount();
    const stranded = [await strandedPayment(10), await strandedPayment(10), await strandedPayment(10)];
    for (const { payment } of stranded) stripe.setIntent(payment.paymentIntentId, "succeeded");
    stripe.failNext(500, { type: "api_error", message: "boom" });
    const summary = await reconcile();
    expect(summary).toMatchObject({ checked: 3, errors: 1, booked: 2 });
    let booked = 0;
    for (const { invoice } of stranded) booked += (await invoicePayments(invoice.id)).length;
    expect(booked).toBe(2);
  });

  it("skips owners whose Stripe account is no longer connected", async () => {
    await connectReadyAccount();
    const { payment } = await strandedPayment(10);
    stripe.setIntent(payment.paymentIntentId, "succeeded");
    await prisma.user.update({ where: { id: user.id }, data: { stripeAccountId: null } });
    expect((await reconcile()).checked).toBe(0);
    expect(reads()).toHaveLength(0);
  });

  it("does nothing without a Stripe key or with POS_RECONCILE=off", async () => {
    await connectReadyAccount();
    const { payment } = await strandedPayment(10);
    stripe.setIntent(payment.paymentIntentId, "succeeded");
    const before = stripe.calls.length;
    try {
      process.env.POS_RECONCILE = "off";
      expect(await reconcile()).toMatchObject({ checked: 0, disabled: true });
      delete process.env.POS_RECONCILE;
      delete process.env.STRIPE_SECRET_KEY;
      expect(await reconcile()).toMatchObject({ checked: 0, disabled: true });
    } finally {
      delete process.env.POS_RECONCILE;
    }
    expect(stripe.calls.length).toBe(before);
  });

  it("logs one summary line without secrets or card data", async () => {
    await connectReadyAccount();
    const { payment } = await strandedPayment(10);
    stripe.setIntent(payment.paymentIntentId, "succeeded");
    const { formatReconcileSummary } = await import("@/lib/pos-payments");
    const line = formatReconcileSummary(await reconcile());
    expect(line).toMatch(/checked=1 .*booked=1/);
    expect(line).not.toContain("4242");
    expect(line).not.toContain(SECRET_KEY);
    expect(line).not.toContain(payment.paymentIntentId);
    expect(line.split("\n")).toHaveLength(1);
  });
});

describe("account data", () => {
  it("the data copy carries korttimaksut.json", async () => {
    await connectReadyAccount();
    const invoice = await invoiceInState();
    await startPayment(invoice.id, 10, "copy");
    const files = readStoredZip(await buildAccountCopyZip(user.id));
    const rows = JSON.parse(files.get("korttimaksut.json")!.toString("utf8"));
    expect(rows[0]).toMatchObject({ livemode: true, testimaksu: false });
    expect(rows[0].huomautus).toBeUndefined();
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
