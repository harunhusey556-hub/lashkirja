import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { consumeRateLimit } from "@/lib/rate-limit";
import { MAX_RECEIPT_REQUEST_BYTES } from "@/lib/storage";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { ChatBusyError } from "@/lib/chat-store";
import { ChatReceiptError, sendReceiptToChat } from "@/lib/chat-receipt";
import { errorText } from "@/lib/api-errors";

/**
 * A receipt sent into the chat (multipart: file, conversationId?, clientId?).
 * 200 { conversationId, receiptId, userMessage, assistantMessage }; errors are
 * { error } in Finnish: 400 missing/invalid file, 401, 404 conversation,
 * 409 clientId reused or reply in progress, 413 too large, 429 rate limit.
 */
export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req, MAX_RECEIPT_REQUEST_BYTES);
  if (oversized) return oversized;

  // Reading the file is a paid model call: the same bucket as every other receipt upload.
  const rate = consumeRateLimit(`receipt-upload:${session.userId}`, 20, 10 * 60_000);
  if (!rate.allowed) {
    return noStoreJson(
      { error: "Liian monta kuittia. Odota hetki." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return noStoreJson({ error: "Virheellinen pyyntö" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return noStoreJson({ error: "Tiedosto puuttuu" }, { status: 400 });
  }
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : undefined;
  };

  try {
    const result = await sendReceiptToChat({
      userId: session.userId,
      file: { name: file.name, buffer: Buffer.from(await file.arrayBuffer()) },
      conversationId: text("conversationId"),
      clientId: text("clientId"),
      signal: req.signal,
    });
    return noStoreJson(result);
  } catch (error) {
    if (error instanceof ChatReceiptError) {
      return noStoreJson({ error: error.message }, { status: error.status });
    }
    if (error instanceof ChatBusyError) {
      return noStoreJson({ error: error.message }, { status: 409 });
    }
    console.error("Chat receipt failed:", errorText(error));
    return noStoreJson({ error: "Kuitin käsittely epäonnistui. Yritä hetken kuluttua uudelleen." }, { status: 500 });
  }
}
