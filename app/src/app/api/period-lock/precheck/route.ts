import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { monthSchema } from "@/lib/validation";
import { listPeriodPrecheck } from "@/lib/period-precheck";

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const month = monthSchema.parse(req.nextUrl.searchParams.get("month"));
  return noStoreJson(await listPeriodPrecheck(session.userId, month));
});
