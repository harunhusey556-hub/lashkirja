import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { redirectResponse, sessionOptions, type SessionData } from "@/lib/session";
import { getIronSession } from "iron-session";
import { z } from "zod";
import { rejectCrossSite, rejectOversizedContentLength, safeInternalPath } from "@/lib/http-security";
import {
  clearRateLimit,
  consumeRateLimit,
  opaqueRateKey,
  requestClientKey,
} from "@/lib/rate-limit";
import { openAuthSession } from "@/lib/account-security";

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(1024),
});

const DUMMY_PASSWORD_HASH =
  "$2b$10$pY981y3NyIOQ/8tQ3VpIOeUi8YLqkZ5Ut.ZveoRZe6crXBQXdzdDG";

async function authenticate(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  const valid = await bcrypt.compare(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
  if (!user) return null;
  return valid ? user : null;
}

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

    const contentType = req.headers.get("content-type") || "";
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

    const credentials = credentialsSchema.safeParse({ email, password });
    if (!credentials.success) {
      if (wantsJson) {
        return NextResponse.json(
          { error: "Sähköposti ja salasana vaaditaan" },
          { status: 400 }
        );
      }
      return loginRedirect("missing");
    }

    email = credentials.data.email;
    password = credentials.data.password;
    const accountRateKey = `login:account:${opaqueRateKey(email)}`;
    const ipRate = consumeRateLimit(`login:ip:${requestClientKey(req)}`, 20, 15 * 60_000);
    const accountRate = consumeRateLimit(accountRateKey, 5, 15 * 60_000);
    if (!ipRate.allowed || !accountRate.allowed) {
      const retryAfter = Math.max(ipRate.retryAfterSeconds, accountRate.retryAfterSeconds);
      if (wantsJson) {
        return NextResponse.json(
          { error: "Liian monta kirjautumisyritystä. Yritä myöhemmin uudelleen." },
          { status: 429, headers: { "Retry-After": String(retryAfter) } }
        );
      }
      const response = loginRedirect("rate");
      response.headers.set("Retry-After", String(retryAfter));
      return response;
    }

    const user = await authenticate(email, password);
    if (!user) {
      if (wantsJson) {
        return NextResponse.json(
          { error: "Sähköposti tai salasana on väärin. Tarkista ja yritä uudelleen." },
          { status: 401 }
        );
      }
      return loginRedirect("auth");
    }
    if (user.accessDisabledAt) {
      if (wantsJson) {
        return NextResponse.json(
          { error: "Tilin käyttö on suljettu. Kirjanpitoaineisto säilyy säilytysajan." },
          { status: 403 }
        );
      }
      return loginRedirect("closed");
    }

    clearRateLimit(accountRateKey);

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
