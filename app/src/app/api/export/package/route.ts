import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { monthSchema } from "@/lib/validation";
import { buildPeriodPackage } from "@/lib/export-package";

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const month = monthSchema.parse(req.nextUrl.searchParams.get("month"));
  const pack = await buildPeriodPackage(session.userId, month);
  return new NextResponse(new Uint8Array(pack.bytes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${pack.fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
