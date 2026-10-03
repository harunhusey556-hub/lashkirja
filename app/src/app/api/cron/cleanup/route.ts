import { NextRequest, NextResponse } from "next/server";
import { cleanupExpiredUploads } from "../../../../../scripts/cleanup-uploads";

import { checkCronAuth } from "@/lib/cron-auth";
import { pruneExpiredPendingSignups } from "@/lib/signup";
import { pruneStaleCodeGuards } from "@/lib/account-code-guard";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const auth = checkCronAuth(req);
  if (!auth.ok) return auth.response;

  try {
    const result = await cleanupExpiredUploads();
    const signups = await pruneExpiredPendingSignups();
    const guards = await pruneStaleCodeGuards();
    return NextResponse.json({
      ok: true,
      message: `Cleaned up ${result.count} records and ${result.deletedFiles} files, ${signups} expired sign-ups and ${guards} code guards.`,
    });
  } catch (error) {
    console.error("Cron upload cleanup failed:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
