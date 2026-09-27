import { NextRequest } from "next/server";
import { collectHealth, healthAuthOk } from "@/lib/health";
import { noStoreJson } from "@/lib/http-security";

export async function GET(req: NextRequest) {
  if (!healthAuthOk(req.headers.get("authorization"))) {
    const missing = !process.env.HEALTH_TOKEN?.trim() && process.env.NODE_ENV === "production";
    return noStoreJson(
      { error: missing ? "HEALTH_TOKEN puuttuu palvelimen asetuksista." : "Unauthorized" },
      { status: missing ? 500 : 401 }
    );
  }
  const report = await collectHealth();
  return noStoreJson(report, { status: report.ok ? 200 : 503 });
}
