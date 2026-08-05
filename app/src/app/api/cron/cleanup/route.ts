import { NextRequest, NextResponse } from "next/server";
import { cleanupExpiredUploads } from "../../../../../scripts/cleanup-uploads";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  // Validate cron secret if configured
  const configuredSecret = process.env.CRON_SECRET;
  if (configuredSecret) {
    const authHeader = req.headers.get("authorization");
    const provided = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : req.nextUrl.searchParams.get("secret");
      
    if (provided !== configuredSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    // Force a secret in production to prevent DoS
    console.warn("Attempt to run cron without CRON_SECRET in production.");
    return NextResponse.json({ error: "Configuration missing" }, { status: 500 });
  }

  try {
    const result = await cleanupExpiredUploads();
    return NextResponse.json({
      ok: true,
      message: `Cleaned up ${result.count} records and ${result.deletedFiles} files.`,
    });
  } catch (error) {
    console.error("Cron upload cleanup failed:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
