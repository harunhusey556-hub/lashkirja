/**
 * Korttimaksut: card payments taken on the phone with Stripe Terminal (Tap to
 * Pay), on the business's OWN Stripe connected account (Connect, direct
 * charges). The platform holds no money.
 *
 * The rule this module exists for: an invoice payment is booked only after the
 * server itself has seen a succeeded PaymentIntent, either by retrieving it from
 * Stripe (finalize) or from a webhook whose signature it verified. The client
 * saying "paid" books nothing. Booking happens at most once per card payment:
 * PosPayment.succeededAt is claimed in the same transaction that inserts the
 * InvoicePayment, and InvoicePayment.posPaymentId is unique as the backstop,
 * so finalize and the webhook may run in any order, any number of times, also
 * at the same moment.
 *
 * Test mode: a payment is booked only when Stripe's PaymentIntent says
 * livemode true AND the server key is a live key (isLivePayment). A test
 * payment is marked succeeded on its PosPayment and goes no further: no
 * InvoicePayment, no invoice status change, no activity line, and a refund of
 * it changes nothing on the invoice. So a test key on the production database
 * cannot put fake money in the books.
 */
import { createHash, randomUUID } from "crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { AppError, ConflictError, NotFoundError, ValidationError } from "./api-errors";
import { centsToEuros, eurosToCents } from "./money";
import { formatEur } from "./format";
import { assertPeriodOpen, getLockedThrough, isDateLocked } from "./period-lock";
import { helsinkiCalendarDate, isoDateToUtc } from "./validation";
import {
  addInvoiceActivity,
  applyInvoicePayment,
  getInvoice,
  reopenIfUncovered,
  type PublicInvoice,
} from "./sales-invoices";
import {
  cancelPaymentIntent,
  createAccountLink,
  createCardPresentIntent,
  createConnectionToken,
  createExpressAccount,
  createRefund,
  createTerminalLocation,
  isLivePayment,
  listRefunds,
  retrieveAccount,
  retrievePaymentIntent,
  StripeApiError,
  StripeDisabledError,
  stripeConfigured,
  type StripeAccount,
  type StripeCharge,
  type StripeEvent,
  type StripePaymentIntent,
  type StripeRefund,
  stripeTestMode,
} from "./stripe";

/** The two places Stripe sends the owner back to after onboarding. */
export const ONBOARDING_STATES = ["return", "refresh"] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];

/** Anything but "refresh" is "return": the redirect target is never taken from the request. */
export function onboardingState(value: string | null | undefined): OnboardingState {
  return value === "refresh" ? "refresh" : "return";
}

/** The app's own deep link the https return page redirects to. */
export function onboardingAppUrl(state: OnboardingState): string {
  return `lashkirja://pos/onboarding?state=${state}`;
}

/**
 * Stripe wants https return/refresh URLs in live mode, so the Account Link
 * points at this server's /api/pos/onboarding/return, which redirects to the
 * app's lashkirja:// link (that redirect ends ASWebAuthenticationSession).
 */
export function onboardingReturnUrl(origin: string, state: OnboardingState): string {
  return `${origin.replace(/\/$/, "")}/api/pos/onboarding/return?state=${state}`;
}

export type PosPaymentStatus =
  | "created"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled"
  | "refunded"
  | "partially_refunded";

/** Statuses after the money moved: never downgraded by a later event. */
const SETTLED: PosPaymentStatus[] = ["succeeded", "refunded", "partially_refunded"];

export interface PosStatus {
  enabled: boolean;
  account: { connected: boolean; chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean };
  locationId: string | null;
  posEnabled: boolean;
  ready: boolean;
  /**
   * The server's key is a Stripe test key: the app may offer its simulated
   * reader. Never true for a live key.
   */
  testMode: boolean;
}

export interface PosPaymentView {
  id: string;
  invoiceId: string | null;
  status: string;
  amount: number;
  refunded: number;
  cardBrand: string | null;
  cardLast4: string | null;
  createdAt: string;
  succeededAt: string | null;
  /** Stripe's livemode for this payment. false: a test payment, never booked. */
  livemode: boolean;
}

export interface CreatedPaymentIntent {
  id: string;
  paymentIntentId: string;
  clientSecret: string;
  locationId: string | null;
  amountCents: number;
  currency: "eur";
}

/** finalize found the PaymentIntent not (yet) succeeded. The body carries its status. */
export class PosPaymentNotSucceededError extends AppError {
  readonly paymentStatus: string;
  constructor(message: string, paymentStatus: string) {
    super(message, "POS_PAYMENT_NOT_SUCCEEDED", 409);
    this.paymentStatus = paymentStatus;
  }
}

type PosPaymentRow = Prisma.PosPaymentGetPayload<object>;

type PosUser = {
  id: string;
  email: string;
  entityType: string;
  firstName: string;
  lastName: string;
  businessName: string | null;
  addressStreet: string | null;
  addressPostalCode: string | null;
  addressCity: string | null;
  stripeAccountId: string | null;
  stripeLocationId: string | null;
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
  stripeDetailsSubmitted: boolean;
  posEnabled: boolean;
};

const posUserSelect = {
  id: true,
  email: true,
  entityType: true,
  firstName: true,
  lastName: true,
  businessName: true,
  addressStreet: true,
  addressPostalCode: true,
  addressCity: true,
  stripeAccountId: true,
  stripeLocationId: true,
  stripeChargesEnabled: true,
  stripePayoutsEnabled: true,
  stripeDetailsSubmitted: true,
  posEnabled: true,
} as const;

export function assertPosFeatureOn(): void {
  if (!stripeConfigured()) throw new StripeDisabledError();
}

async function loadUser(userId: string): Promise<PosUser> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: posUserSelect });
  if (!user) throw new NotFoundError("Käyttäjää ei löytynyt.");
  return user;
}

function statusOf(user: PosUser): PosStatus {
  const enabled = stripeConfigured();
  return {
    enabled,
    account: {
      connected: Boolean(user.stripeAccountId),
      chargesEnabled: user.stripeChargesEnabled,
      payoutsEnabled: user.stripePayoutsEnabled,
      detailsSubmitted: user.stripeDetailsSubmitted,
    },
    locationId: user.stripeLocationId,
    posEnabled: user.posEnabled,
    ready: Boolean(
      enabled && user.stripeAccountId && user.stripeChargesEnabled && user.stripeLocationId && user.posEnabled
    ),
    testMode: enabled && stripeTestMode(),
  };
}

function requireReady(user: PosUser): { account: string; location: string } {
  const status = statusOf(user);
  if (!status.ready || !user.stripeAccountId || !user.stripeLocationId) {
    throw new ConflictError(
      "Korttimaksut eivät ole vielä käytössä. Viimeistele käyttöönotto ja ota korttimaksut käyttöön asetuksista.",
      "POS_NOT_READY"
    );
  }
  return { account: user.stripeAccountId, location: user.stripeLocationId };
}

export function toPosPaymentView(row: PosPaymentRow): PosPaymentView {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    status: row.status,
    amount: centsToEuros(row.amountCents),
    refunded: centsToEuros(row.refundedCents),
    cardBrand: row.cardBrand,
    cardLast4: row.cardLast4,
    createdAt: row.createdAt.toISOString(),
    succeededAt: row.succeededAt ? row.succeededAt.toISOString() : null,
    livemode: row.livemode,
  };
}

// ---------------------------------------------------------------------------
// Account: status, onboarding, settings, connection token
// ---------------------------------------------------------------------------

export async function getPosStatus(userId: string): Promise<PosStatus> {
  return statusOf(await loadUser(userId));
}

function businessTypeFor(entityType: string): "individual" | "company" | null {
  if (entityType === "oy") return "company";
  // A toiminimi and a kevytyrittäjä are natural persons in Stripe's terms.
  if (entityType === "toiminimi" || entityType === "kevytyrittaja") return "individual";
  return null;
}

/** Creates the connected account on first use and returns a fresh onboarding link. */
export async function startOnboarding(userId: string, origin: string): Promise<{ url: string }> {
  assertPosFeatureOn();
  const user = await loadUser(userId);
  let accountId = user.stripeAccountId;
  if (!accountId) {
    // The idempotency key makes two parallel taps create one account at Stripe;
    // the conditional update makes them store one id here.
    const account = await createExpressAccount(
      { email: user.email, businessType: businessTypeFor(user.entityType), userId },
      `lashkirja:account:${userId}`
    );
    const stored = await prisma.user.updateMany({
      where: { id: userId, stripeAccountId: null },
      data: { stripeAccountId: account.id },
    });
    accountId = stored.count === 1 ? account.id : (await loadUser(userId)).stripeAccountId;
    if (!accountId) throw new AppError("Korttimaksutilin luonti epäonnistui. Yritä uudelleen.", "POS_ACCOUNT_RACE", 409);
  }
  const link = await createAccountLink({
    account: accountId,
    refreshUrl: onboardingReturnUrl(origin, "refresh"),
    returnUrl: onboardingReturnUrl(origin, "return"),
  });
  return { url: link.url };
}

async function storeAccountFlags(userId: string, account: StripeAccount): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      stripeChargesEnabled: Boolean(account.charges_enabled),
      stripePayoutsEnabled: Boolean(account.payouts_enabled),
      stripeDetailsSubmitted: Boolean(account.details_submitted),
    },
  });
}

/**
 * Re-reads the connected account from Stripe and, once it can take charges,
 * creates its Terminal Location from the business address (once).
 */
export async function refreshOnboarding(userId: string): Promise<PosStatus> {
  assertPosFeatureOn();
  const user = await loadUser(userId);
  if (!user.stripeAccountId) {
    throw new ConflictError("Korttimaksutiliä ei ole vielä luotu. Aloita käyttöönotto.", "POS_NO_ACCOUNT");
  }
  const account = await retrieveAccount(user.stripeAccountId);
  await storeAccountFlags(userId, account);

  if (account.charges_enabled && !user.stripeLocationId) {
    const line1 = user.addressStreet?.trim();
    const postalCode = user.addressPostalCode?.trim();
    const city = user.addressCity?.trim();
    if (!line1 || !postalCode || !city) {
      throw new AppError(
        "Lisää yrityksen osoite (katuosoite, postinumero ja postitoimipaikka) yrityksen tietoihin ennen korttimaksujen käyttöönottoa.",
        "POS_ADDRESS_MISSING",
        422
      );
    }
    const displayName = user.businessName?.trim() || `${user.firstName} ${user.lastName}`.trim() || "LashKirja";
    const location = await createTerminalLocation(
      user.stripeAccountId,
      { displayName: displayName.slice(0, 100), line1, city, postalCode },
      `lashkirja:location:${userId}:${user.stripeAccountId}`
    );
    await prisma.user.updateMany({
      where: { id: userId, stripeLocationId: null },
      data: { stripeLocationId: location.id },
    });
  }
  return getPosStatus(userId);
}

export async function setPosEnabled(userId: string, posEnabled: boolean): Promise<PosStatus> {
  assertPosFeatureOn();
  if (posEnabled) {
    const updated = await prisma.user.updateMany({
      where: { id: userId, stripeChargesEnabled: true, stripeAccountId: { not: null } },
      data: { posEnabled: true },
    });
    if (updated.count === 0) {
      throw new ConflictError(
        "Korttimaksuja ei voi ottaa käyttöön ennen kuin Stripe on hyväksynyt tilin. Viimeistele käyttöönotto.",
        "POS_CHARGES_DISABLED"
      );
    }
  } else {
    await prisma.user.update({ where: { id: userId }, data: { posEnabled: false } });
  }
  return getPosStatus(userId);
}

/** A Terminal connection token minted on the connected account. Not cached. */
export async function issueConnectionToken(userId: string): Promise<{ secret: string }> {
  assertPosFeatureOn();
  const { account, location } = requireReady(await loadUser(userId));
  const token = await createConnectionToken(account, location);
  return { secret: token.secret };
}

// ---------------------------------------------------------------------------
// PaymentIntents
// ---------------------------------------------------------------------------

/** The same client key always maps to the same PosPayment id (and Stripe call). */
function paymentIdForKey(userId: string, key: string): string {
  const hex = createHash("sha256").update(`pos-payment:${userId}:${key}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Starts a card payment for (part of) a sent invoice: checks the invoice and
 * the amount, creates a card_present PaymentIntent on the connected account and
 * stores the PosPayment. Nothing is booked on the invoice here.
 */
export async function createPosPaymentIntent(
  userId: string,
  input: { invoiceId: string; amount: number },
  clientKey: string | null
): Promise<CreatedPaymentIntent> {
  assertPosFeatureOn();
  const user = await loadUser(userId);
  const { account, location } = requireReady(user);
  const amountCents = eurosToCents(input.amount);
  if (amountCents <= 0) throw new ValidationError("Summan pitää olla suurempi kuin nolla.");

  const posPaymentId = clientKey ? paymentIdForKey(userId, clientKey) : randomUUID();
  const existing = await prisma.posPayment.findFirst({ where: { id: posPaymentId, userId } });
  if (existing) {
    // The stored answer was lost after the row was written: answer the same payment.
    const intent = await retrievePaymentIntent(account, existing.providerPaymentIntentId);
    return {
      id: existing.id,
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret ?? "",
      locationId: location,
      amountCents: existing.amountCents,
      currency: "eur",
    };
  }

  const invoice = await prisma.salesInvoice.findFirst({
    where: { id: input.invoiceId, userId },
    select: {
      id: true,
      number: true,
      status: true,
      documentKind: true,
      grossCents: true,
      payments: { select: { amountCents: true } },
    },
  });
  if (!invoice) throw new NotFoundError("Laskua ei löytynyt.");
  if (invoice.status === "draft") {
    throw new AppError("Luonnokselle ei voi ottaa korttimaksua. Lähetä lasku ensin.", "INVOICE_IS_DRAFT", 409);
  }
  if (invoice.status === "credited" || invoice.documentKind === "credit_note") {
    throw new AppError("Hyvitetylle laskulle ei voi ottaa korttimaksua.", "INVOICE_CREDITED", 409);
  }
  if (invoice.status !== "sent") {
    throw new AppError("Lasku on jo maksettu.", "INVOICE_ALREADY_PAID", 409);
  }
  const openCents = invoice.grossCents - invoice.payments.reduce((sum, row) => sum + row.amountCents, 0);
  if (amountCents > openCents) {
    throw new AppError(
      openCents <= 0
        ? "Lasku on jo maksettu."
        : `Summa on suurempi kuin laskun avoin summa (${formatEur(centsToEuros(openCents))}).`,
      "PAYMENT_EXCEEDS_OPEN",
      422,
      { openCents }
    );
  }
  // The payment will be dated today: today's month must be open.
  await assertPeriodOpen(userId, [isoDateToUtc(helsinkiCalendarDate())]);

  const intent = await createCardPresentIntent(
    account,
    {
      amountCents,
      description: `Lasku ${invoice.number}`,
      metadata: { invoiceId: invoice.id, posPaymentId, userId },
    },
    `lashkirja:pos-intent:${userId}:${clientKey ?? posPaymentId}`
  );
  if (intent.amount !== amountCents || !intent.client_secret) {
    throw new AppError("Korttimaksun luonti epäonnistui. Yritä uudelleen.", "POS_INTENT_MISMATCH", 502);
  }
  await prisma.posPayment.create({
    data: {
      id: posPaymentId,
      userId,
      invoiceId: invoice.id,
      provider: "stripe",
      providerPaymentIntentId: intent.id,
      amountCents,
      currency: "EUR",
      status: "created",
      idempotencyKey: clientKey,
      livemode: intent.livemode === true,
    },
  });
  return {
    id: posPaymentId,
    paymentIntentId: intent.id,
    clientSecret: intent.client_secret,
    locationId: location,
    amountCents,
    currency: "eur",
  };
}

async function requirePosPayment(userId: string, id: string): Promise<PosPaymentRow> {
  const row = await prisma.posPayment.findFirst({ where: { id, userId } });
  if (!row) throw new NotFoundError("Korttimaksua ei löytynyt.");
  return row;
}

async function accountFor(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { stripeAccountId: true } });
  if (!user?.stripeAccountId) {
    throw new ConflictError("Korttimaksutiliä ei ole yhdistetty.", "POS_NO_ACCOUNT");
  }
  return user.stripeAccountId;
}

function chargeOf(intent: StripePaymentIntent): StripeCharge | null {
  return intent.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge : null;
}

function cardOf(charge: StripeCharge | null): { brand: string | null; last4: string | null } {
  const details = charge?.payment_method_details;
  const card = details?.card_present ?? details?.interac_present ?? null;
  return { brand: card?.brand ?? null, last4: card?.last4 ?? null };
}

/**
 * Books a PaymentIntent Stripe reports as succeeded: claims the PosPayment
 * (succeededAt) and inserts the InvoicePayment in one transaction. A second
 * caller finds the claim taken and books nothing. A test payment is claimed
 * the same way but books nothing at all.
 */
async function bookSucceeded(pos: PosPaymentRow, intent: StripePaymentIntent): Promise<void> {
  if (intent.currency.toLowerCase() !== "eur") {
    throw new AppError("Korttimaksun valuutta ei ole euro.", "POS_CURRENCY", 409);
  }
  const charge = chargeOf(intent);
  const card = cardOf(charge);
  const amountCents = intent.amount_received;
  const livemode = intent.livemode === true;
  const books = isLivePayment(livemode);
  const now = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.posPayment.updateMany({
        where: { id: pos.id, succeededAt: null },
        data: {
          livemode,
          amountCents,
          providerChargeId: charge?.id ?? null,
          cardBrand: card.brand,
          cardLast4: card.last4,
          failureCode: null,
          failureMessage: null,
          succeededAt: now,
        },
      });
      if (claimed.count === 0) return;
      const fresh = await tx.posPayment.findUniqueOrThrow({ where: { id: pos.id } });
      // A refund that arrived before the booking is already netted out.
      const bookedCents = amountCents - Math.min(fresh.refundedCents, amountCents);
      await tx.posPayment.update({
        where: { id: pos.id },
        data: { status: refundStatus(amountCents, fresh.refundedCents) ?? "succeeded" },
      });
      // A test payment stops here: it is succeeded at Stripe, never in the books.
      if (books && fresh.invoiceId && bookedCents > 0) {
        await applyInvoicePayment(tx, fresh.userId, fresh.invoiceId, {
          amountCents: bookedCents,
          paidDate: helsinkiCalendarDate(now),
          source: "stripe_terminal",
          posPaymentId: fresh.id,
          note: card.last4 ? `Kortti •••• ${card.last4}` : "Korttimaksu",
        });
      }
    });
  } catch (error) {
    // Another caller booked it in between: the unique posPaymentId refused ours.
    if ((error as { code?: string }).code === "P2002") return;
    if (error instanceof AppError) {
      // Stripe has the money but the books refused the row (e.g. the month was
      // closed in between). Keep the fact visible; succeededAt stays empty so a
      // later finalize books it.
      await prisma.posPayment.updateMany({
        where: { id: pos.id, succeededAt: null },
        data: {
          status: "succeeded",
          livemode,
          amountCents,
          providerChargeId: charge?.id ?? null,
          cardBrand: card.brand,
          cardLast4: card.last4,
          failureCode: error.code,
          failureMessage: `Maksua ei voitu kirjata laskulle: ${error.message}`,
        },
      });
    }
    throw error;
  }
}

function refundStatus(amountCents: number, refundedCents: number): PosPaymentStatus | null {
  if (refundedCents <= 0) return null;
  return refundedCents >= amountCents ? "refunded" : "partially_refunded";
}

/** Applies what Stripe says about a PaymentIntent. Returns its status. */
async function applyIntent(pos: PosPaymentRow, intent: StripePaymentIntent): Promise<string> {
  if (intent.id !== pos.providerPaymentIntentId) {
    throw new AppError("Korttimaksu ei vastaa laskun maksua.", "POS_INTENT_MISMATCH", 409);
  }
  // Re-checked from Stripe on every read until the payment is claimed; after
  // that it stays what decided the booking.
  await prisma.posPayment.updateMany({
    where: { id: pos.id, succeededAt: null },
    data: { livemode: intent.livemode === true },
  });
  const status = intent.status;
  if (status === "succeeded") {
    await bookSucceeded(pos, intent);
    return status;
  }
  const notSettled = { id: pos.id, status: { notIn: SETTLED } };
  if (status === "canceled") {
    await prisma.posPayment.updateMany({ where: notSettled, data: { status: "canceled" } });
  } else if (status === "processing") {
    await prisma.posPayment.updateMany({ where: notSettled, data: { status: "processing" } });
  } else if (status === "requires_payment_method" && intent.last_payment_error) {
    await prisma.posPayment.updateMany({
      where: notSettled,
      data: {
        status: "failed",
        failureCode: (intent.last_payment_error.decline_code ?? intent.last_payment_error.code ?? "declined").slice(0, 64),
        // Stripe's text stays in the database for support; the user sees a Finnish line.
        failureMessage: "Kortti hylättiin.",
      },
    });
  }
  return status;
}

const PENDING_MESSAGES: Record<string, string> = {
  processing: "Maksu on vielä kesken. Yritä hetken päästä uudelleen.",
  canceled: "Maksu peruttiin. Laskulle ei kirjattu maksua.",
  requires_payment_method: "Maksua ei ole vielä veloitettu kortilta.",
  requires_confirmation: "Maksua ei ole vielä vahvistettu.",
  requires_action: "Maksu odottaa vielä vahvistusta.",
  requires_capture: "Maksu odottaa vielä veloitusta.",
};

export interface FinalizedPayment {
  payment: PosPaymentView;
  invoice: PublicInvoice | null;
  /** An invoice payment exists for this card payment. */
  booked: boolean;
  /** A Stripe test payment: never booked ("Testimaksu – ei kirjattu laskulle"). */
  testPayment: boolean;
  /** A refund in a locked month waits as a correction card in Huomioitavat. */
  correctionPending: boolean;
}

async function viewWithInvoice(userId: string, id: string): Promise<FinalizedPayment> {
  const row = await requirePosPayment(userId, id);
  const booked = await prisma.invoicePayment.count({ where: { posPaymentId: row.id } });
  const pending = await prisma.posRefund.count({ where: { posPaymentId: row.id, books: "correction_pending" } });
  return {
    payment: toPosPaymentView(row),
    invoice: row.invoiceId ? await getInvoice(userId, row.invoiceId) : null,
    booked: booked > 0,
    testPayment: !isLivePayment(row.livemode),
    correctionPending: pending > 0,
  };
}

/**
 * The app's "is it paid?" call after the reader finished. The server asks
 * Stripe; only a succeeded PaymentIntent books the payment.
 */
export async function finalizePosPayment(userId: string, id: string): Promise<FinalizedPayment> {
  assertPosFeatureOn();
  const pos = await requirePosPayment(userId, id);
  const intent = await retrievePaymentIntent(await accountFor(userId), pos.providerPaymentIntentId);
  const status = await applyIntent(pos, intent);
  if (status !== "succeeded") {
    throw new PosPaymentNotSucceededError(PENDING_MESSAGES[status] ?? "Maksu ei ole vielä onnistunut.", status);
  }
  return viewWithInvoice(userId, id);
}

/** Cancels a card payment that has not been charged. */
export async function cancelPosPayment(userId: string, id: string): Promise<FinalizedPayment> {
  assertPosFeatureOn();
  const pos = await requirePosPayment(userId, id);
  const account = await accountFor(userId);
  const intent = await retrievePaymentIntent(account, pos.providerPaymentIntentId);
  if (intent.status === "succeeded") {
    await applyIntent(pos, intent);
    const test = !isLivePayment((await requirePosPayment(userId, id)).livemode);
    throw new PosPaymentNotSucceededError(
      test
        ? "Maksu ehti jo onnistua, eikä sitä voi perua. Testimaksu – ei kirjattu laskulle."
        : "Maksu ehti jo onnistua, eikä sitä voi perua. Se kirjattiin laskulle; palauta maksu tarvittaessa.",
      "succeeded"
    );
  }
  if (intent.status !== "canceled") {
    try {
      await applyIntent(pos, await cancelPaymentIntent(account, pos.providerPaymentIntentId));
    } catch (error) {
      if (!(error instanceof StripeApiError) || error.stripeCode !== "payment_intent_unexpected_state") throw error;
      // It moved on at Stripe in between: take whatever state it is in now.
      const now = await retrievePaymentIntent(account, pos.providerPaymentIntentId);
      await applyIntent(pos, now);
      if (now.status !== "canceled") {
        throw new PosPaymentNotSucceededError("Maksua ei voitu enää perua.", now.status);
      }
    }
  } else {
    await applyIntent(pos, intent);
  }
  return viewWithInvoice(userId, id);
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/** One Stripe refund, as the books need it. */
interface RefundInfo {
  id: string;
  amountCents: number;
  createdAt: Date;
}

/** Refunds that took (or may still take) money back: not failed or canceled. */
function refundInfos(refunds: StripeRefund[]): RefundInfo[] {
  return refunds
    .filter((refund) => refund.status !== "failed" && refund.status !== "canceled" && refund.amount > 0)
    .map((refund) => ({
      id: refund.id,
      amountCents: refund.amount,
      createdAt: refund.created ? new Date(refund.created * 1000) : new Date(),
    }));
}

const CARDED: string[] = ["correction_pending", "corrected"];

/**
 * Brings the books in line with what Stripe has refunded for a card payment.
 *
 * The PosPayment always shows the refunded total (absolute and only ever
 * growing, so the route, its retry and the webhook change nothing the second
 * time). For a booked live payment, every Stripe refund id is recorded once in
 * PosRefund (unique), and then:
 * - the payment's month is open: the invoice payment shrinks by the refunds
 *   not handled by a correction, or goes when nothing is left, and a paid
 *   invoice reopens (the behaviour before locked months were handled);
 * - the payment's month is locked: the locked month is never changed. Each new
 *   refund becomes a correction card in Huomioitavat; accepting it
 *   (acceptRefundCorrection) posts a negative card payment row in the first
 *   open month.
 * A test payment (stored livemode false, a test key, or Stripe saying test)
 * only has its refunded total updated: never the invoice, never a card.
 */
async function applyRefundTotal(
  tx: Prisma.TransactionClient,
  posId: string,
  totalRefundedCents: number,
  options: { stripeLivemode: boolean; refunds: RefundInfo[] }
): Promise<void> {
  // Write first: takes the write lock before the reads below.
  await tx.posPayment.updateMany({ where: { id: posId }, data: { refundedCents: { increment: 0 } } });
  const pos = await tx.posPayment.findUniqueOrThrow({ where: { id: posId } });
  const total = Math.min(pos.amountCents, Math.max(pos.refundedCents, totalRefundedCents));
  const delta = total - pos.refundedCents;
  if (delta > 0) {
    await tx.posPayment.update({
      where: { id: pos.id },
      data: {
        refundedCents: total,
        refundedAt: new Date(),
        // Before booking (succeededAt empty) only the total is kept; the booking nets it out.
        ...(pos.succeededAt ? { status: refundStatus(pos.amountCents, total) ?? pos.status } : {}),
      },
    });
  }
  if (!pos.succeededAt || !pos.invoiceId) return;
  if (!options.stripeLivemode || !isLivePayment(pos.livemode)) return;
  const booked = await tx.invoicePayment.findUnique({ where: { posPaymentId: pos.id } });
  if (!booked) return;

  const known = await tx.posRefund.findMany({
    where: { posPaymentId: pos.id },
    select: { stripeRefundId: true, amountCents: true, books: true },
  });
  const knownIds = new Set(known.map((row) => row.stripeRefundId));
  const fresh = options.refunds.filter((refund) => !knownIds.has(refund.id));
  const lockedThrough = await getLockedThrough(pos.userId, tx);
  const locked = isDateLocked(lockedThrough, booked.paidDate);

  for (const refund of fresh) {
    await tx.posRefund.create({
      data: {
        userId: pos.userId,
        posPaymentId: pos.id,
        stripeRefundId: refund.id,
        amountCents: refund.amountCents,
        refundedAt: refund.createdAt,
        books: locked ? "correction_pending" : "applied",
      },
    });
  }

  if (locked) {
    for (const refund of fresh) {
      await addInvoiceActivity(
        tx,
        pos.invoiceId,
        "pos_refund",
        `Korttimaksu palautettu ${formatEur(centsToEuros(refund.amountCents))}. Maksun kuukausi on lukittu – korjaus odottaa hyväksyntää Huomioitavissa.`
      );
    }
    // A refund Stripe reported only as a total (no refund object): noted for the owner.
    const unnamed = delta - fresh.reduce((sum, refund) => sum + refund.amountCents, 0);
    if (unnamed > 0) {
      await addInvoiceActivity(
        tx,
        pos.invoiceId,
        "pos_refund",
        `Korttimaksu palautettu ${formatEur(centsToEuros(unnamed))}. Maksun kuukausi on lukittu, joten laskun maksua ei muutettu.`
      );
    }
    return;
  }

  if (delta <= 0) return;
  // Refunds that have a correction card are handled by the correction, not here.
  const cardedCents = known
    .filter((row) => CARDED.includes(row.books))
    .reduce((sum, row) => sum + row.amountCents, 0);
  const remaining = pos.amountCents - Math.max(0, total - cardedCents);
  if (remaining <= 0) {
    await tx.invoicePayment.delete({ where: { id: booked.id } });
  } else {
    await tx.invoicePayment.update({ where: { id: booked.id }, data: { amountCents: remaining } });
  }
  await addInvoiceActivity(tx, pos.invoiceId, "pos_refund", `Korttimaksu palautettu ${formatEur(centsToEuros(delta))}.`);
  await reopenIfUncovered(tx, pos.invoiceId);
}

/** Stripe's refunds of this payment, only when the books could need their ids. */
async function refundsForBooks(account: string, pos: PosPaymentRow, stripeLivemode: boolean): Promise<RefundInfo[]> {
  if (!stripeLivemode || !isLivePayment(pos.livemode) || !pos.succeededAt || !pos.invoiceId) return [];
  return refundInfos((await listRefunds(account, pos.providerPaymentIntentId)).data);
}

/**
 * Refunds (part of) a card payment. `idempotencyKey` is the client's key for this refund: it goes
 * to Stripe as is, so a retry after a lost answer is the same refund there and never a second one,
 * whatever the server's own total did in between (a charge.refunded webhook, say). The total booked
 * is what Stripe reports as refunded on the charge, not a sum the server keeps.
 *
 * A locked payment month does not stop the refund: the money goes back at Stripe, the card
 * payment shows it, and the books get a correction card instead of a change to the closed month.
 */
export async function refundPosPayment(
  userId: string,
  id: string,
  amount: number | null | undefined,
  idempotencyKey: string
): Promise<FinalizedPayment> {
  assertPosFeatureOn();
  const pos = await requirePosPayment(userId, id);
  // A full refund retried after it went through: nothing is left, and that is the answer.
  if (amount == null && pos.status === "refunded") return viewWithInvoice(userId, id);
  if (!pos.succeededAt || !(pos.status === "succeeded" || pos.status === "partially_refunded")) {
    throw new ConflictError("Vain onnistuneen korttimaksun voi palauttaa.", "POS_NOT_REFUNDABLE");
  }
  const left = pos.amountCents - pos.refundedCents;
  const cents = amount == null ? left : eurosToCents(amount);
  if (cents <= 0) throw new ValidationError("Palautuksen pitää olla suurempi kuin nolla.");
  if (cents > left) {
    throw new AppError(
      `Palautus on suurempi kuin palauttamatta oleva summa (${formatEur(centsToEuros(left))}).`,
      "REFUND_EXCEEDS_PAYMENT",
      422,
      { leftCents: left }
    );
  }

  const account = await accountFor(userId);
  const refund = await createRefund(
    account,
    { paymentIntent: pos.providerPaymentIntentId, amountCents: cents, metadata: { posPaymentId: pos.id, userId } },
    `lashkirja:pos-refund:${userId}:${pos.id}:${idempotencyKey}`
  );
  if (refund.status === "failed" || refund.status === "canceled") {
    throw new AppError("Palautus epäonnistui. Yritä uudelleen.", "POS_REFUND_FAILED", 502);
  }
  const intent = await retrievePaymentIntent(account, pos.providerPaymentIntentId);
  const charge = intent.latest_charge;
  if (!charge || typeof charge === "string" || typeof charge.amount_refunded !== "number") {
    throw new AppError("Palautuksen tilaa ei saatu Stripestä. Yritä uudelleen.", "POS_REFUND_UNKNOWN", 502);
  }
  const stripeLivemode = intent.livemode === true;
  const listed = await refundsForBooks(account, pos, stripeLivemode);
  // The refund just made is in the list too; it is added in case the list lags behind.
  const refunds = listed.some((row) => row.id === refund.id)
    ? listed
    : [...listed, ...refundInfos([refund])];
  await prisma.$transaction((tx) =>
    applyRefundTotal(tx, pos.id, charge.amount_refunded, {
      stripeLivemode,
      refunds: stripeLivemode && isLivePayment(pos.livemode) ? refunds : [],
    })
  );
  return viewWithInvoice(userId, id);
}

/** The first day that is not in a locked month, or the refund day if that is later. */
export function correctionDate(lockedThrough: string | null, refundedAt: Date): string {
  const refundDay = helsinkiCalendarDate(refundedAt);
  if (!lockedThrough || !/^\d{4}-\d{2}$/.test(lockedThrough)) return refundDay;
  const [year, month] = lockedThrough.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  const firstOpen = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
  return refundDay > firstOpen ? refundDay : firstOpen;
}

/**
 * The owner accepts a correction card: a negative card payment row for the
 * refunded amount is posted in the first open month (or on the refund day, if
 * that is later), and the locked month stays as it was. Once per refund: the
 * card is claimed (correction_pending -> corrected) in the same transaction
 * that posts the row, so a repeated or concurrent accept posts nothing more.
 */
export async function acceptRefundCorrection(userId: string, posRefundId: string): Promise<PublicInvoice> {
  const invoiceId = await prisma.$transaction(async (tx) => {
    const claimed = await tx.posRefund.updateMany({
      where: { id: posRefundId, userId, books: "correction_pending" },
      data: { books: "corrected", correctedAt: new Date() },
    });
    const row = await tx.posRefund.findFirst({
      where: { id: posRefundId, userId },
      include: { posPayment: { select: { invoiceId: true, cardLast4: true } } },
    });
    if (!row) throw new NotFoundError("Korjausta ei löytynyt.");
    const target = row.posPayment.invoiceId;
    if (!target) throw new ConflictError("Korttimaksun laskua ei enää ole.", "POS_CORRECTION_NO_INVOICE");
    if (claimed.count === 0) return target;

    const paidDate = correctionDate(await getLockedThrough(userId, tx), row.refundedAt);
    const correctionId = await applyInvoicePayment(tx, userId, target, {
      amountCents: -row.amountCents,
      paidDate,
      source: "stripe_terminal",
      note: row.posPayment.cardLast4
        ? `Korttimaksun palautus, kortti •••• ${row.posPayment.cardLast4} (lukitun kuukauden korjaus)`
        : "Korttimaksun palautus (lukitun kuukauden korjaus)",
    });
    await tx.posRefund.update({ where: { id: row.id }, data: { correctionPaymentId: correctionId } });
    return target;
  });
  return getInvoice(userId, invoiceId);
}

export async function listPosPayments(userId: string, invoiceId?: string | null): Promise<PosPaymentView[]> {
  assertPosFeatureOn();
  const rows = await prisma.posPayment.findMany({
    where: { userId, ...(invoiceId ? { invoiceId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map(toPosPaymentView);
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * A verified Connect event. Every lookup is scoped to the user who owns the
 * event's connected account, so an event cannot touch another business.
 * Unknown events and accounts are ignored (answered 200 by the route).
 */
export async function handleStripeEvent(event: StripeEvent): Promise<void> {
  const object = event.data?.object ?? {};
  const accountId = str(event.account) ?? (event.type === "account.updated" ? str(object.id) : null);
  if (!accountId) return;
  const user = await prisma.user.findUnique({ where: { stripeAccountId: accountId }, select: { id: true } });
  if (!user) return;

  switch (event.type) {
    case "account.updated": {
      await storeAccountFlags(user.id, {
        id: accountId,
        charges_enabled: Boolean(object.charges_enabled),
        payouts_enabled: Boolean(object.payouts_enabled),
        details_submitted: Boolean(object.details_submitted),
      });
      return;
    }
    case "payment_intent.succeeded":
    case "payment_intent.processing":
    case "payment_intent.payment_failed":
    case "payment_intent.canceled": {
      const intentId = str(object.id);
      if (!intentId) return;
      const pos = await prisma.posPayment.findFirst({ where: { providerPaymentIntentId: intentId, userId: user.id } });
      if (!pos) return;
      // Re-read from Stripe: events can arrive out of order, and the expanded
      // charge carries the card details.
      const intent = await retrievePaymentIntent(accountId, intentId);
      try {
        await applyIntent(pos, intent);
      } catch (error) {
        // The books refused (e.g. a closed month): kept on the PosPayment, and
        // a retry from Stripe would be refused the same way.
        if (!(error instanceof AppError) || error instanceof StripeApiError) throw error;
        console.warn("[stripe webhook] payment not booked", event.type, pos.id, error.code);
      }
      return;
    }
    case "charge.refunded": {
      const intentId = str(object.payment_intent);
      const refunded = typeof object.amount_refunded === "number" ? object.amount_refunded : null;
      if (!intentId || refunded === null) return;
      const pos = await prisma.posPayment.findFirst({ where: { providerPaymentIntentId: intentId, userId: user.id } });
      if (!pos) return;
      // The charge and the event both say whether this is a test-mode refund.
      const stripeLivemode = object.livemode === true && event.livemode !== false;
      // The charge carries only the total; the refund ids come from Stripe's list.
      const refunds = await refundsForBooks(accountId, pos, stripeLivemode);
      await prisma.$transaction((tx) => applyRefundTotal(tx, pos.id, refunded, { stripeLivemode, refunds }));
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Reconcile (worker): the safety net for what the app and the webhook missed
// ---------------------------------------------------------------------------

/** Not settled yet: Stripe may still have moved the money. "failed" can still succeed on a retried tap. */
const RECONCILE_STATUSES: PosPaymentStatus[] = ["created", "processing", "failed"];

export const RECONCILE_DEFAULTS = {
  /** Younger payments are still in the app's own hands (finalize, webhook). */
  minAgeMs: 10 * 60_000,
  /** Older ones are left alone; a payment that old is support's to look at. */
  maxAgeMs: 7 * 24 * 60 * 60_000,
  /** Stripe reads per cycle, all owners together. */
  maxReads: 20,
  /** Stripe reads per cycle for one owner. */
  maxReadsPerOwner: 5,
  /** Reads in flight at once. */
  concurrency: 4,
  /** No new read starts after this; reads already started finish (each has Stripe's own 20 s timeout). */
  deadlineMs: 60_000,
} as const;

export type ReconcileOptions = Partial<Record<keyof typeof RECONCILE_DEFAULTS, number>> & { now?: Date };

export interface ReconcileSummary {
  /** POS_RECONCILE=off or no Stripe key: nothing was read. */
  disabled: boolean;
  owners: number;
  checked: number;
  succeeded: number;
  /** Succeeded and an invoice payment exists for it (booked now or earlier). */
  booked: number;
  /** Succeeded at Stripe in test mode: never booked. */
  testPayments: number;
  canceled: number;
  failed: number;
  /** Still processing or waiting for a card at Stripe: left as is. */
  pending: number;
  errors: number;
  /** Left for the next cycle because the deadline passed. */
  skipped: number;
}

export function reconcileEnabled(): boolean {
  const flag = process.env.POS_RECONCILE?.trim().toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return false;
  return stripeConfigured();
}

/**
 * Finds card payments that are 10 minutes to 7 days old and not settled, asks
 * Stripe about each (on the owner's connected account) and applies the answer
 * through applyIntent, the very path finalize and the webhook use: a succeeded
 * payment is booked once (a test payment never), a canceled one is marked
 * canceled, anything else is left as finalize would leave it. It only reads
 * from Stripe: it never creates, confirms or cancels a PaymentIntent.
 */
export async function reconcilePosPayments(options: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    disabled: false,
    owners: 0,
    checked: 0,
    succeeded: 0,
    booked: 0,
    testPayments: 0,
    canceled: 0,
    failed: 0,
    pending: 0,
    errors: 0,
    skipped: 0,
  };
  if (!reconcileEnabled()) return { ...summary, disabled: true };

  const limits = { ...RECONCILE_DEFAULTS, ...options };
  const now = options.now ?? new Date();
  const where = {
    status: { in: RECONCILE_STATUSES },
    succeededAt: null,
    createdAt: { gte: new Date(now.getTime() - limits.maxAgeMs), lte: new Date(now.getTime() - limits.minAgeMs) },
    user: { stripeAccountId: { not: null } },
  };

  // Owners with the oldest waiting payment first; no more owners than reads.
  const owners = await prisma.posPayment.groupBy({
    by: ["userId"],
    where,
    _min: { createdAt: true },
    orderBy: { _min: { createdAt: "asc" } },
    take: limits.maxReads,
  });
  const picked: Array<{ id: string; userId: string; account: string; reconciledAt: Date | null; createdAt: Date }> = [];
  for (const owner of owners) {
    const rows = await prisma.posPayment.findMany({
      where: { ...where, userId: owner.userId },
      // Never-checked first (oldest first), then the least recently checked.
      orderBy: [{ reconciledAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      take: limits.maxReadsPerOwner,
      select: { id: true, userId: true, reconciledAt: true, createdAt: true, user: { select: { stripeAccountId: true } } },
    });
    for (const row of rows) {
      if (row.user.stripeAccountId) picked.push({ ...row, account: row.user.stripeAccountId });
    }
  }
  picked.sort(
    (a, b) =>
      (a.reconciledAt?.getTime() ?? 0) - (b.reconciledAt?.getTime() ?? 0) || a.createdAt.getTime() - b.createdAt.getTime()
  );
  const queue = picked.slice(0, limits.maxReads);
  summary.owners = new Set(queue.map((row) => row.userId)).size;

  const deadline = Date.now() + limits.deadlineMs;
  const reconcileOne = async (item: (typeof queue)[number]) => {
    summary.checked += 1;
    try {
      await prisma.posPayment.update({ where: { id: item.id }, data: { reconciledAt: new Date() } });
      const pos = await prisma.posPayment.findUniqueOrThrow({ where: { id: item.id } });
      const intent = await retrievePaymentIntent(item.account, pos.providerPaymentIntentId);
      const status = await applyIntent(pos, intent);
      const after = await prisma.posPayment.findUniqueOrThrow({
        where: { id: item.id },
        select: { status: true, livemode: true, invoicePayment: { select: { id: true } } },
      });
      if (status === "succeeded") {
        summary.succeeded += 1;
        if (after.invoicePayment) summary.booked += 1;
        else if (!isLivePayment(after.livemode)) summary.testPayments += 1;
      } else if (after.status === "canceled") {
        summary.canceled += 1;
      } else if (after.status === "failed") {
        summary.failed += 1;
      } else {
        summary.pending += 1;
      }
    } catch (error) {
      summary.errors += 1;
      // Classification only: no ids from Stripe, no card data, no key.
      const code = error instanceof AppError ? error.code : error instanceof Error ? error.name : "error";
      console.warn("[pos reconcile] payment not reconciled", item.id, code);
    }
  };

  let next = 0;
  const lane = async () => {
    while (next < queue.length) {
      if (Date.now() > deadline) {
        summary.skipped += queue.length - next;
        next = queue.length;
        return;
      }
      const item = queue[next];
      next += 1;
      await reconcileOne(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limits.concurrency, queue.length)) }, lane));
  return summary;
}

/** One log line: counts only. */
export function formatReconcileSummary(summary: ReconcileSummary): string {
  if (summary.disabled) return "POS reconcile disabled";
  return (
    `POS reconcile owners=${summary.owners} checked=${summary.checked} succeeded=${summary.succeeded} ` +
    `booked=${summary.booked} test=${summary.testPayments} canceled=${summary.canceled} failed=${summary.failed} ` +
    `pending=${summary.pending} errors=${summary.errors} skipped=${summary.skipped}`
  );
}
