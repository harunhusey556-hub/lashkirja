import { NextRequest, NextResponse } from "next/server";
import { rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { checkCredentials } from "@/lib/auth-login";
import { openBearerSession } from "@/lib/account-security";
import { acceptDeviceKey } from "@/lib/device-key";

/**
 * Password login for the bundled app: exchanges email + password for a
 * bearer token tied to a fresh AuthSession row. Never sets a cookie — the
 * app stores the token itself (see the app-side secure storage plugin).
 */
export async function POST(req: NextRequest) {
  try {
    const crossSite = rejectCrossSite(req);
    if (crossSite) return crossSite;
    const oversized = rejectOversizedContentLength(req, 32 * 1024);
    if (oversized) return oversized;

    const body = await req.json().catch(() => ({}));
    const email = String(body?.email ?? "").trim();
    const password = String(body?.password ?? "");
    const device = body?.device === "ios-app" ? ("ios-app" as const) : undefined;

    const result = await checkCredentials(req, email, password);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        {
          status: result.status,
          headers: result.retryAfter ? { "Retry-After": String(result.retryAfter) } : undefined,
        }
      );
    }

    const deviceKey = acceptDeviceKey(body?.deviceKey, "POST /api/auth/token");
    const sealed = await openBearerSession(result.user, req.headers.get("user-agent"), device, deviceKey);

    return NextResponse.json({
      token: sealed.token,
      tokenType: "Bearer",
      expiresAt: sealed.expiresAt.toISOString(),
      user: { userId: result.user.id, email: result.user.email, firstName: result.user.firstName },
    });
  } catch (error) {
    console.error("Token issue failed:", error);
    return NextResponse.json({ error: "Kirjautuminen epäonnistui" }, { status: 500 });
  }
}
