import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { z } from "zod";
import { buildPeriodPackage } from "@/lib/export-package";

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  // One month, a quarter or a whole year (SALES-21).
  const month = z
    .string()
    .regex(/^\d{4}(?:-(?:0[1-9]|1[0-2])|-Q[1-4])?$/, "Kausi on muotoa VVVV-KK, VVVV-Qn tai VVVV.")
    .parse(req.nextUrl.searchParams.get("month"));
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
