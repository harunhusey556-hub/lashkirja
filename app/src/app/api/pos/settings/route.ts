import { z } from "zod";
import { noStoreJson } from "@/lib/http-security";
import { setPosEnabled } from "@/lib/pos-payments";
import { posRoute } from "@/lib/pos-route";

const bodySchema = z.object({ posEnabled: z.boolean() }).strict();

export const PATCH = posRoute({ write: true }, async (req, session) => {
  const input = bodySchema.parse(await req.json());
  return noStoreJson(await setPosEnabled(session.userId, input.posEnabled));
});
