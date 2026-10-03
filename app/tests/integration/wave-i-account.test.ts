import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as me } from "@/app/api/auth/me/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as changePasswordRoute } from "@/app/api/auth/password/route";
import { POST as forgotPassword } from "@/app/api/auth/password/forgot/route";
import { POST as resetPassword } from "@/app/api/auth/password/reset/route";
import { POST as requestEmail } from "@/app/api/auth/email/route";
import { POST as confirmEmail } from "@/app/api/auth/email/confirm/route";
import { GET as listSessions, POST as revokeSessions } from "@/app/api/auth/sessions/route";
import { POST as accountRequest } from "@/app/api/account/request/route";
import { PATCH as patchProfile } from "@/app/api/profile/route";
import { POST as saveOnboarding } from "@/app/api/onboarding/route";
import { POST as postChat } from "@/app/api/ai/chat/route";
import { prisma } from "@/lib/db";
import { requestEmailChange, settleAccountMailForTests } from "@/lib/account-security";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson } from "./helpers/http";

const PASSWORD = "salasana1234";

let user: TestUser;

function cookieOf(response: Response): string {
  const parts =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") || ""];
  const match = parts.join(";").match(/lashkirja-session=[^;]+/);
  if (!match) throw new Error(`session cookie missing: ${parts.join(" | ")}`);
  return match[0];
}

async function loginAs(email: string, userAgent: string) {
  const response = await login(
    buildRequest(
      "POST",
      "/api/auth/login",
      { email, password: PASSWORD },
      { headers: { "user-agent": userAgent, accept: "application/json" } }
    )
  );
  expect(response.status).toBe(200);
  return cookieOf(response);
}

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(PASSWORD, 4) },
  });
});

describe("wave I account", () => {
  it("tracks two logins and revokes the other device", async () => {
    const phone = await loginAs(user.email, "Mozilla/5.0 (iPhone) Safari/605");
    const laptop = await loginAs(user.email, "Mozilla/5.0 (Macintosh) Chrome/120");
    const listed = await listSessions(buildRequest("GET", "/api/auth/sessions", undefined, { cookie: phone }));
    const sessions = (await readJson<{ sessions: { id: string; current: boolean; label: string }[] }>(listed)).sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((row) => row.current)).toHaveLength(1);
    expect(sessions.some((row) => row.label.includes("iPhone"))).toBe(true);

    const revoked = await revokeSessions(
      buildRequest("POST", "/api/auth/sessions", { scope: "others" }, { cookie: phone })
    );
    expect(revoked.status).toBe(200);
    expect((await me(buildRequest("GET", "/api/auth/me", undefined, { cookie: laptop }))).status).toBe(401);
    expect((await me(buildRequest("GET", "/api/auth/me", undefined, { cookie: phone }))).status).toBe(200);
  });

  it("changes the password only with the current one and drops the other session", async () => {
    const here = await loginAs(user.email, "Mozilla/5.0 (Linux) Firefox/120");
    const there = await loginAs(user.email, "Mozilla/5.0 (Windows) Chrome/120");
    const wrong = await changePasswordRoute(
      buildRequest(
        "POST",
        "/api/auth/password",
        { currentPassword: "vaara-salasana", newPassword: "uusi-salasana-123" },
        { cookie: here }
      )
    );
    expect(wrong.status).toBe(401);
    const short = await changePasswordRoute(
      buildRequest(
        "POST",
        "/api/auth/password",
        { currentPassword: PASSWORD, newPassword: "lyhyt" },
        { cookie: here }
      )
    );
    expect(short.status).toBe(400);
    const changed = await changePasswordRoute(
      buildRequest(
        "POST",
        "/api/auth/password",
        { currentPassword: PASSWORD, newPassword: "uusi-salasana-123" },
        { cookie: here }
      )
    );
    expect(changed.status).toBe(200);
    expect((await me(buildRequest("GET", "/api/auth/me", undefined, { cookie: there }))).status).toBe(401);
    expect((await me(buildRequest("GET", "/api/auth/me", undefined, { cookie: here }))).status).toBe(200);

    const oldLogin = await login(
      buildRequest("POST", "/api/auth/login", { email: user.email, password: PASSWORD }, { headers: { accept: "application/json" } })
    );
    expect(oldLogin.status).toBe(401);
    const nextLogin = await login(
      buildRequest(
        "POST",
        "/api/auth/login",
        { email: user.email, password: "uusi-salasana-123" },
        { headers: { accept: "application/json" } }
      )
    );
    expect(nextLogin.status).toBe(200);
  });

  it("does not apply a new email until the confirmation token is used", async () => {
    const cookie = await loginAs(user.email, "Mozilla/5.0 (Linux) Firefox/120");
    const patched = await patchProfile(
      buildRequest("PATCH", "/api/profile", { email: "vaihdettu@example.com", firstName: "Aino" }, { cookie })
    );
    expect(patched.status).toBe(200);
    const afterPatch = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(afterPatch.email).toBe(user.email);
    expect(afterPatch.firstName).toBe("Aino");

    const denied = await requestEmail(
      buildRequest(
        "POST",
        "/api/auth/email",
        { email: "uusi@example.com", currentPassword: "vaara" },
        { cookie }
      )
    );
    expect(denied.status).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingEmail).toBeNull();

    // No mail transport: the change is refused as a whole and nothing stays
    // pending that could never be confirmed (F53).
    const undelivered = await requestEmail(
      buildRequest(
        "POST",
        "/api/auth/email",
        { email: "uusi@example.com", currentPassword: PASSWORD },
        { cookie }
      )
    );
    expect(undelivered.status).toBe(409);
    const refusal = await readJson<{ error: string; ok?: boolean }>(undelivered);
    expect(refusal.ok).toBeUndefined();
    expect(refusal.error).toMatch(/ei vaihdettu/);
    expect(refusal.error).not.toMatch(/lähetyspostia/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingEmail).toBeNull();
    expect(
      await prisma.accountToken.count({ where: { userId: user.id, purpose: "email_change", usedAt: null } })
    ).toBe(0);

    process.env.PLATFORM_SMTP_HOST = "smtp.test.invalid";
    process.env.PLATFORM_SMTP_FROM = "no-reply@test.invalid";
    process.env.MAIL_TRANSPORT = "json";
    let pending: Response;
    try {
      pending = await requestEmail(
        buildRequest(
          "POST",
          "/api/auth/email",
          { email: "uusi@example.com", currentPassword: PASSWORD },
          { cookie }
        )
      );
    } finally {
      delete process.env.PLATFORM_SMTP_HOST;
      delete process.env.PLATFORM_SMTP_FROM;
      delete process.env.MAIL_TRANSPORT;
    }
    expect(pending.status).toBe(200);
    const body = await readJson<{ pendingEmail: string; token?: string }>(pending);
    expect(body.pendingEmail).toBe("uusi@example.com");
    expect(body.token).toBeUndefined();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);

    const minted = await requestEmailChange(user.id, "uusi@example.com", PASSWORD);
    const confirmed = await confirmEmail(
      buildRequest("POST", "/api/auth/email/confirm", { token: minted.token }, { cookie })
    );
    expect(confirmed.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe("uusi@example.com");
    const again = await confirmEmail(
      buildRequest("POST", "/api/auth/email/confirm", { token: minted.token })
    );
    expect(again.status).toBe(400);
  });

  it("resets a password from a single-use token and keeps unknown emails quiet", async () => {
    const missing = await forgotPassword(
      buildRequest("POST", "/api/auth/password/forgot", { email: "ei-ole@example.com" })
    );
    expect(missing.status).toBe(200);
    await settleAccountMailForTests();
    expect(await prisma.accountToken.count()).toBe(0);

    const sent = await forgotPassword(
      buildRequest("POST", "/api/auth/password/forgot", { email: user.email })
    );
    expect(sent.status).toBe(200);
    await settleAccountMailForTests();
    const payload = await readJson<{ token?: string; message: string; mailConfigured: boolean }>(sent);
    expect(payload.token).toBeUndefined();
    // No PLATFORM_SMTP_* in the test env: the text must not claim a send, and
    // an unknown address gets the very same answer.
    expect(payload.mailConfigured).toBe(false);
    expect(payload.message).toMatch(/tukeen/);
    expect(payload.message).not.toMatch(/matkalla|lähetettiin|Tietosuoja/);
    expect(
      (await readJson<{ message: string }>(missing)).message
    ).toBe(payload.message);
    expect(await prisma.accountToken.count()).toBe(1);

    const { issuePasswordReset } = await import("@/lib/account-security");
    const token = await issuePasswordReset(user.id);
    const reset = await resetPassword(
      buildRequest("POST", "/api/auth/password/reset", { token, password: "palautettu-salasana" })
    );
    expect(reset.status).toBe(200);
    const reused = await resetPassword(
      buildRequest("POST", "/api/auth/password/reset", { token, password: "toinen-salasana-123" })
    );
    expect(reused.status).toBe(400);
    const next = await login(
      buildRequest(
        "POST",
        "/api/auth/login",
        { email: user.email, password: "palautettu-salasana" },
        { headers: { accept: "application/json" } }
      )
    );
    expect(next.status).toBe(200);
  });

  it("revokes the server session on logout and refuses a failed-looking retry path", async () => {
    const cookie = await loginAs(user.email, "Mozilla/5.0 (Linux) Firefox/120");
    const response = await logout(
      buildRequest("POST", "/api/auth/logout", undefined, {
        cookie,
        headers: { accept: "application/json" },
      })
    );
    expect(response.status).toBe(200);
    expect((await me(buildRequest("GET", "/api/auth/me", undefined, { cookie }))).status).toBe(401);
    const row = await prisma.authSession.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.revokedAt).not.toBeNull();
  });

  it("validates onboarding on the server and guards chat and profile writes", async () => {
    const cookie = await loginAs(user.email, "Mozilla/5.0 (Linux) Firefox/120");
    const bad = await saveOnboarding(
      buildRequest(
        "POST",
        "/api/onboarding",
        {
          entityType: "osuuskunta",
          vatRegistered: true,
          vatPeriod: "month",
          salesTypes: ["ripsipalvelut"],
          expenseCategories: ["tarvikkeet"],
        },
        { cookie }
      )
    );
    expect(bad.status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).entityType).toBe(
      "toiminimi"
    );

    const saved = await saveOnboarding(
      buildRequest(
        "POST",
        "/api/onboarding",
        {
          entityType: "oy",
          vatRegistered: true,
          vatPeriod: "quarter",
          salesTypes: ["ripsipalvelut"],
          expenseCategories: ["vuokra"],
        },
        { cookie }
      )
    );
    expect(saved.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).entityType).toBe("oy");

    const cross = await postChat(
      buildRequest(
        "POST",
        "/api/ai/chat",
        { message: "hei" },
        { cookie, origin: "http://evil.test", secFetchSite: "cross-site" }
      )
    );
    expect(cross.status).toBe(403);
    const huge = await patchProfile(
      buildRequest("PATCH", "/api/profile", { firstName: "x".repeat(300_000) }, { cookie })
    );
    expect(huge.status).toBe(413);
  });

  it("records an account-close request without deleting the books", async () => {
    const cookie = await loginAs(user.email, "Mozilla/5.0 (Linux) Firefox/120");
    const denied = await accountRequest(
      buildRequest("POST", "/api/account/request", { kind: "close", currentPassword: "vaara" }, { cookie })
    );
    expect(denied.status).toBe(401);
    const accepted = await accountRequest(
      buildRequest("POST", "/api/account/request", { kind: "close", currentPassword: PASSWORD }, { cookie })
    );
    expect(accepted.status).toBe(200);
    const body = await readJson<{ message: string }>(accepted);
    expect(body.message).toMatch(/6 vuotta/);
    // One story for the toast, the dialog and the login refusal (F55).
    expect(body.message).toMatch(/kirjautuminen estetään/);
    expect(body.message).not.toMatch(/ei suljeta/);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    expect(await prisma.accountRequest.count({ where: { userId: user.id, kind: "close" } })).toBe(1);
  });
});
