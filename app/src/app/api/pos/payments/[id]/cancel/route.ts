import { noStoreJson } from "@/lib/http-security";
import { cancelPosPayment } from "@/lib/pos-payments";
import { posRoute, type PosRouteContext } from "@/lib/pos-route";

export const POST = posRoute({ write: true }, async (_req, session, context: PosRouteContext) => {
  const { id } = await context.params;
  const { payment } = await cancelPosPayment(session.userId, id);
  return noStoreJson({ payment });
});
