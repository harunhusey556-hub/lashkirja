import { NextRequest, NextResponse } from "next/server";
import { redirectResponse, sessionOptions, type SessionData } from "@/lib/session";
import { getIronSession } from "iron-session";
import { rejectCrossSite, rejectOversizedContentLength, safeInternalPath } from "@/lib/http-security";
import { openAuthSession } from "@/lib/account-security";
import { checkCredentials, type AuthenticatedUser } from "@/lib/auth-login";

const ERROR_CODE_FOR_STATUS: Record<number, string> = {
  400: "missing",
  401: "auth",
  403: "closed",
  429: "rate",
};

async function writeSession(
  req: NextRequest,
  res: NextResponse,
  user: { id: string; email: string; firstName: string }
) {
  const row = await openAuthSession(user.id, req.headers.get("user-agent"));
  const session = await getIronSession<SessionData>(req, res, sessionOptions);
  session.userId = user.id;
  session.email = user.email;
  session.firstName = user.firstName;
  session.sessionId = row.id;
  await session.save();
}

export async function POST(req: NextRequest) {
  const wantsJson = (req.headers.get("content-type") || "").includes("application/json");
  try {
    const crossSite = rejectCrossSite(req);
    if (crossSite) return crossSite;
    const oversized = rejectOversizedContentLength(req, 32 * 1024);
    if (oversized) return oversized;

    let email = "";
    let password = "";
    let next = "";

    if (wantsJson) {
      const body = await req.json().catch(() => ({}));
      email = String(body.email || "").trim();
      password = String(body.password || "");
      next = String(body.next || "");
    } else {
      const form = await req.formData();
      email = String(form.get("email") || "").trim();
      password = String(form.get("password") || "");
      next = String(form.get("next") || "");
    }

    // Deep-link continue-after-login: re-validate here too, since this field
    // arrives as ordinary request input regardless of what proxy.ts sent.
    const nextPath = next ? safeInternalPath(next, "") : "";
    const loginRedirect = (errorCode: string) =>
      redirectResponse(
        nextPath
          ? `/login?error=${errorCode}&next=${encodeURIComponent(nextPath)}`
          : `/login?error=${errorCode}`
      );

    const result = await checkCredentials(req, email, password);
    if (!result.ok) {
      if (wantsJson) {
        return NextResponse.json(
          { error: result.error },
          {
            status: result.status,
            headers: result.retryAfter ? { "Retry-After": String(result.retryAfter) } : undefined,
          }
        );
      }
      const response = loginRedirect(ERROR_CODE_FOR_STATUS[result.status] ?? "auth");
      if (result.retryAfter) response.headers.set("Retry-After", String(result.retryAfter));
      return response;
    }

    const user: AuthenticatedUser = result.user;

    if (wantsJson) {
      const res = NextResponse.json({
        ok: true,
        user: { firstName: user.firstName, email: user.email },
      });
      await writeSession(req, res, user);
      return res;
    }

    // 303 redirect after form POST — browser stores cookie before /dashboard,
    // or back to the originally requested deep link when there is one.
    const res = redirectResponse(nextPath || "/dashboard");
    await writeSession(req, res, user);
    return res;
  } catch (error) {
    console.error("Login failed:", error);
    if (wantsJson) {
      return NextResponse.json(
        { error: "Kirjautuminen epäonnistui" },
        { status: 500 }
      );
    }
    return redirectResponse("/login?error=server");
  }
}
