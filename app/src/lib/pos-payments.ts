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
  retrieveAccount,
  retrievePaymentIntent,
  StripeApiError,
  StripeDisabledError,
  stripeConfigured,
  type StripeAccount,
  type StripeCharge,
  type StripeEvent,
  type StripePaymentIntent,
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
 * caller finds the claim taken and books nothing.
 */
async function bookSucceeded(pos: PosPaymentRow, intent: StripePaymentIntent): Promise<void> {
  if (intent.currency.toLowerCase() !== "eur") {
    throw new AppError("Korttimaksun valuutta ei ole euro.", "POS_CURRENCY", 409);
  }
  const charge = chargeOf(intent);
  const card = cardOf(charge);
  const amountCents = intent.amount_received;
  const now = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.posPayment.updateMany({
        where: { id: pos.id, succeededAt: null },
        data: {
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
      if (fresh.invoiceId && bookedCents > 0) {
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
}

async function viewWithInvoice(userId: string, id: string): Promise<FinalizedPayment> {
  const row = await requirePosPayment(userId, id);
  return {
    payment: toPosPaymentView(row),
    invoice: row.invoiceId ? await getInvoice(userId, row.invoiceId) : null,
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
    throw new PosPaymentNotSucceededError(
      "Maksu ehti jo onnistua, eikä sitä voi perua. Se kirjattiin laskulle; palauta maksu tarvittaessa.",
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

/**
 * Brings the books in line with the total Stripe has refunded for a card
 * payment. The total is absolute and only ever grows, so applying the same
 * refund twice (route, then webhook) changes nothing the second time.
 * The booked invoice payment shrinks by the refund, or goes when nothing is
 * left, and a paid invoice reopens when it is no longer covered.
 */
async function applyRefundTotal(
  tx: Prisma.TransactionClient,
  posId: string,
  totalRefundedCents: number,
  options: { allowLockedMonth: boolean }
): Promise<boolean> {
  // Write first: takes the write lock before the read below.
  await tx.posPayment.updateMany({ where: { id: posId }, data: { refundedCents: { increment: 0 } } });
  const pos = await tx.posPayment.findUniqueOrThrow({ where: { id: posId } });
  const total = Math.min(pos.amountCents, Math.max(pos.refundedCents, totalRefundedCents));
  if (total === pos.refundedCents) return false;
  const delta = total - pos.refundedCents;
  const now = new Date();
  await tx.posPayment.update({
    where: { id: pos.id },
    data: {
      refundedCents: total,
      refundedAt: now,
      // Before booking (succeededAt empty) only the total is kept; the booking nets it out.
      ...(pos.succeededAt ? { status: refundStatus(pos.amountCents, total) ?? pos.status } : {}),
    },
  });
  if (!pos.succeededAt || !pos.invoiceId) return true;

  const booked = await tx.invoicePayment.findUnique({ where: { posPaymentId: pos.id } });
  const amountText = formatEur(centsToEuros(delta));
  if (!booked) return true;
  const lockedThrough = await getLockedThrough(pos.userId, tx);
  if (isDateLocked(lockedThrough, booked.paidDate)) {
    if (!options.allowLockedMonth) await assertPeriodOpen(pos.userId, [booked.paidDate], tx);
    // A refund made in the Stripe Dashboard while the month is closed: the
    // money already went back, so it is recorded on the card payment and noted
    // on the invoice for the owner to book by hand.
    await addInvoiceActivity(
      tx,
      pos.invoiceId,
      "pos_refund",
      `Korttimaksu palautettu ${amountText}. Maksun kuukausi on suljettu, joten laskun maksua ei muutettu.`
    );
    return true;
  }
  const remaining = pos.amountCents - total;
  if (remaining <= 0) {
    await tx.invoicePayment.delete({ where: { id: booked.id } });
  } else {
    await tx.invoicePayment.update({ where: { id: booked.id }, data: { amountCents: remaining } });
  }
  await addInvoiceActivity(tx, pos.invoiceId, "pos_refund", `Korttimaksu palautettu ${amountText}.`);
  await reopenIfUncovered(tx, pos.invoiceId);
  return true;
}

/** Refunds (part of) a booked card payment on the connected account. */
/**
 * Refunds (part of) a card payment. `idempotencyKey` is the client's key for this refund: it goes
 * to Stripe as is, so a retry after a lost answer is the same refund there and never a second one,
 * whatever the server's own total did in between (a charge.refunded webhook, say). The total booked
 * is what Stripe reports as refunded on the charge, not a sum the server keeps.
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
  const booked = await prisma.invoicePayment.findUnique({ where: { posPaymentId: pos.id }, select: { paidDate: true } });
  if (booked) await assertPeriodOpen(userId, [booked.paidDate]);

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
  await prisma.$transaction((tx) =>
    applyRefundTotal(tx, pos.id, charge.amount_refunded, { allowLockedMonth: false })
  );
  return viewWithInvoice(userId, id);
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
      await prisma.$transaction((tx) => applyRefundTotal(tx, pos.id, refunded, { allowLockedMonth: true }));
      return;
    }
    default:
      return;
  }
}
