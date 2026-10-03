import { z } from "zod";
import { noStoreJson } from "@/lib/http-security";
import { listPosPayments } from "@/lib/pos-payments";
import { posRoute } from "@/lib/pos-route";

const invoiceIdSchema = z.string().uuid().nullable();

export const GET = posRoute({ write: false }, async (req, session) => {
  const invoiceId = invoiceIdSchema.parse(req.nextUrl.searchParams.get("invoiceId"));
  return noStoreJson({ payments: await listPosPayments(session.userId, invoiceId) });
});
