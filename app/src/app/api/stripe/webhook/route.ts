import { NextRequest } from "next/server";
import { noStoreJson, rejectOversizedContentLength } from "@/lib/http-security";
import { handleStripeEvent } from "@/lib/pos-payments";
import {
  POS_DISABLED_MESSAGE,
  stripeConfigured,
  verifyWebhookSignature,
  webhookSecret,
  type StripeEvent,
} from "@/lib/stripe";

const WEBHOOK_BODY_LIMIT = 512 * 1024;

/**
 * Stripe Connect webhook. No session: the Stripe-Signature HMAC over the raw
 * body is the authentication. Answers 200 for events it does not use, 400 for
 * a bad signature, and 500 when processing failed so Stripe retries.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const secret = webhookSecret();
  if (!secret || !stripeConfigured()) {
    return noStoreJson({ error: POS_DISABLED_MESSAGE }, { status: 503 });
  }
  const oversized = rejectOversizedContentLength(req, WEBHOOK_BODY_LIMIT);
  if (oversized) return oversized;

  const raw = await req.text();
  if (raw.length > WEBHOOK_BODY_LIMIT) return noStoreJson({ error: "Pyyntö on liian suuri" }, { status: 413 });
  if (!verifyWebhookSignature(raw, req.headers.get("stripe-signature"), secret)) {
    return noStoreJson({ error: "Allekirjoitus ei kelpaa." }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    return noStoreJson({ error: "Pyyntöä ei voitu lukea." }, { status: 400 });
  }
  if (!event || typeof event.type !== "string" || !event.data || typeof event.data.object !== "object") {
    return noStoreJson({ error: "Pyyntöä ei voitu lukea." }, { status: 400 });
  }

  try {
    await handleStripeEvent(event);
  } catch (error) {
    console.error("[stripe webhook] processing failed", event.type, error instanceof Error ? error.name : "error");
    return noStoreJson({ error: "Tapahtuman käsittely epäonnistui." }, { status: 500 });
  }
  return noStoreJson({ received: true });
}
