import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as signupStart } from "@/app/api/auth/signup/start/route";
import { POST as signupVerify } from "@/app/api/auth/signup/verify/route";
import { POST as signupResend } from "@/app/api/auth/signup/resend/route";
import { GET as signupStatus } from "@/app/api/auth/signup/status/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as changePasswordRoute } from "@/app/api/auth/password/route";
import { POST as forgotPassword } from "@/app/api/auth/password/forgot/route";
import { POST as resetPassword } from "@/app/api/auth/password/reset/route";
import { POST as confirmEmail } from "@/app/api/auth/email/confirm/route";
import { prisma } from "@/lib/db";
import { issuePasswordReset, requestEmailChange } from "@/lib/account-security";
import { readCredential } from "@/lib/auth-credential";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/** Every platform mail the code under test composes, in order. */
const outbox = vi.hoisted(() => ({ mails: [] as { to: string; subject: string; text: string }[] }));

vi.mock("@/lib/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mailer")>();
  return {
    ...actual,
    sendPlatformMail: async (...args: Parameters<typeof actual.sendPlatformMail>) => {
      const sent = await actual.sendPlatformMail(...args);
      outbox.mails.push({ to: args[0].to, subject: args[0].subject, text: args[0].text });
      return sent;
    },
  };
});

const PASSWORD = "salasana1234";
const NEW_EMAIL = "uusi.kayttaja@example.com";

let user: TestUser;

function codeIn(text: string): string {
  const match = text.match(/\b(\d{6})\b/);
  if (!match) throw new Error(`no 6-digit code in: ${text}`);
  return match[1];
}

function mailsTo(address: string) {
  return outbox.mails.filter((mail) => mail.to === address);
}

function start(body: Record<string, unknown>) {
  return signupStart(buildRequest("POST", "/api/auth/signup/start", body));
}

function verify(body: Record<string, unknown>) {
  return signupVerify(buildRequest("POST", "/api/auth/signup/verify", body));
}

function resend(body: Record<string, unknown>) {
  return signupResend(buildRequest("POST", "/api/auth/signup/resend", body));
}

function enableMail() {
  process.env.PLATFORM_SMTP_HOST = "smtp.test.invalid";
  process.env.PLATFORM_SMTP_FROM = "no-reply@test.invalid";
  process.env.MAIL_TRANSPORT = "json";
}

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  await prisma.pendingSignup.deleteMany();
  outbox.mails.length = 0;
  enableMail();
  process.env.SIGNUP_ENABLED = "true";
  user = await createUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(PASSWORD, 4) },
  });
});

afterEach(() => {
  delete process.env.PLATFORM_SMTP_HOST;
  delete process.env.PLATFORM_SMTP_FROM;
  delete process.env.MAIL_TRANSPORT;
  delete process.env.SIGNUP_ENABLED;
});

describe("sign-up with an emailed code", () => {
  it("creates the user only after the code and signs the app in", async () => {
    const started = await start({ email: " Uusi.Kayttaja@Example.com ", password: PASSWORD, firstName: "Uusi" });
    expect(started.status).toBe(200);
    expect(await readJson(started)).toEqual({ ok: true, mailConfigured: true });
    expect(await prisma.user.count({ where: { email: NEW_EMAIL } })).toBe(0);

    const pending = await prisma.pendingSignup.findUniqueOrThrow({ where: { email: NEW_EMAIL } });
    const [mail] = mailsTo(NEW_EMAIL);
    const code = codeIn(mail.subject);
    expect(mail.subject).toBe(`LashKirja-vahvistuskoodi: ${code}`);
    expect(mail.text).toContain(code);
    expect(mail.text).toContain("voimassa 15 minuuttia");
    // Only a hash of the code is stored, and the password is bcrypt.
    expect(JSON.stringify(pending)).not.toContain(code);
    expect(pending.passwordHash).not.toContain(PASSWORD);

    const verified = await verify({ email: NEW_EMAIL, code, device: "ios-app" });
    expect(verified.status).toBe(200);
    const body = await readJson(verified);
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "token", "tokenType", "user"]);
    expect(body.tokenType).toBe("Bearer");
    expect(body.user).toMatchObject({ email: NEW_EMAIL, firstName: "Uusi" });
    const credential = await readCredential(
      new Headers({ authorization: `Bearer ${body.token}` }),
      undefined,
      () => false
    );
    expect(credential?.kind).toBe("bearer");
    expect(credential?.data.userId).toBe(body.user.userId);

    const created = await prisma.user.findUniqueOrThrow({ where: { email: NEW_EMAIL } });
    expect(await bcrypt.compare(PASSWORD, created.passwordHash)).toBe(true);
    expect(await prisma.pendingSignup.count()).toBe(0);
    expect(await prisma.authSession.count({ where: { userId: created.id } })).toBe(1);
    expect(mailsTo(NEW_EMAIL)).toHaveLength(2);
    expect(mailsTo(NEW_EMAIL)[1].text).toMatch(/Tervetuloa|tervetuloa/);

    const loggedIn = await login(
      buildRequest(
        "POST",
        "/api/auth/login",
        { email: NEW_EMAIL, password: PASSWORD },
        { headers: { accept: "application/json" } }
      )
    );
    expect(loggedIn.status).toBe(200);

    const reused = await verify({ email: NEW_EMAIL, code });
    expect(reused.status).toBe(410);
  });

  it("answers an existing address exactly like a new one and mails the owner instead", async () => {
    const fresh = await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" });
    const taken = await start({ email: user.email, password: PASSWORD, firstName: "Joku" });
    expect(taken.status).toBe(fresh.status);
    expect(await readJson(taken)).toEqual(await readJson(fresh));
    expect(await prisma.pendingSignup.count({ where: { email: user.email } })).toBe(0);
    const [notice] = mailsTo(user.email);
    expect(notice.text).toContain("Joku yritti luoda LashKirja-tilin osoitteellasi");
    expect(notice.text).toContain("/unohtunut-salasana");
    expect(notice.text).not.toMatch(/\b\d{6}\b/);
  });

  it("voids the pending sign-up after five wrong codes", async () => {
    await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" });
    const code = codeIn(mailsTo(NEW_EMAIL)[0].subject);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await verify({ email: NEW_EMAIL, code: wrong });
      expect(response.status).toBe(400);
      expect(await readJson(response)).toEqual({
        error: "Koodi ei kelpaa.",
        code: "SIGNUP_CODE_INVALID",
        attemptsLeft: 5 - attempt,
      });
    }
    const voided = await verify({ email: NEW_EMAIL, code });
    expect(voided.status).toBe(410);
    expect((await readJson(voided)).code).toBe("SIGNUP_EXPIRED");
    expect(await prisma.user.count({ where: { email: NEW_EMAIL } })).toBe(0);
  });

  it("refuses an expired code", async () => {
    await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" });
    const code = codeIn(mailsTo(NEW_EMAIL)[0].subject);
    await prisma.pendingSignup.update({
      where: { email: NEW_EMAIL },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const response = await verify({ email: NEW_EMAIL, code });
    expect(response.status).toBe(410);
    expect((await readJson(response)).code).toBe("SIGNUP_EXPIRED");
    expect(await prisma.user.count({ where: { email: NEW_EMAIL } })).toBe(0);
  });

  it("a new start replaces the old code, and resend mails a new one", async () => {
    await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" });
    const first = codeIn(mailsTo(NEW_EMAIL)[0].subject);
    await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" });
    expect(await prisma.pendingSignup.count()).toBe(1);

    const resent = await resend({ email: NEW_EMAIL });
    expect(resent.status).toBe(200);
    const missing = await resend({ email: "ei-ole@example.com" });
    expect(missing.status).toBe(200);
    expect(await readJson(missing)).toEqual(await readJson(resent));
    expect(mailsTo("ei-ole@example.com")).toHaveLength(0);

    const latest = codeIn(mailsTo(NEW_EMAIL).at(-1)!.subject);
    expect(mailsTo(NEW_EMAIL)).toHaveLength(3);
    if (latest !== first) {
      const stale = await verify({ email: NEW_EMAIL, code: first });
      expect(stale.status).toBe(400);
    }
    expect((await verify({ email: NEW_EMAIL, code: latest })).status).toBe(200);
  });

  it("rate-limits start per email and resend per minute", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" })).status).toBe(200);
    }
    const blocked = await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" });
    expect(blocked.status).toBe(429);
    expect((await readJson(blocked)).error).toMatch(/Liian monta/);

    expect((await resend({ email: NEW_EMAIL })).status).toBe(200);
    expect((await resend({ email: NEW_EMAIL })).status).toBe(429);
  });

  it("rate-limits start per client address", async () => {
    for (let i = 0; i < 20; i += 1) {
      const response = await start({ email: `ip-${i}@example.com`, password: PASSWORD, firstName: "Uusi" });
      expect(response.status).toBe(200);
    }
    const blocked = await start({ email: "ip-20@example.com", password: PASSWORD, firstName: "Uusi" });
    expect(blocked.status).toBe(429);
  });

  it("is off unless SIGNUP_ENABLED is true", async () => {
    delete process.env.SIGNUP_ENABLED;
    for (const response of [
      await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" }),
      await verify({ email: NEW_EMAIL, code: "123456" }),
      await resend({ email: NEW_EMAIL }),
    ]) {
      expect(response.status).toBe(403);
      expect(await readJson(response)).toEqual({
        error: "Uusien tilien luonti ei ole käytössä.",
        code: "SIGNUP_DISABLED",
      });
    }
    expect(await readJson(await signupStatus())).toEqual({
      enabled: false,
    });
    process.env.SIGNUP_ENABLED = "false";
    expect((await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" })).status).toBe(403);
    process.env.SIGNUP_ENABLED = "true";
    expect(await readJson(await signupStatus())).toEqual({
      enabled: true,
    });
    expect(await prisma.pendingSignup.count()).toBe(0);
  });

  it("stores nothing when platform mail is not configured", async () => {
    delete process.env.PLATFORM_SMTP_HOST;
    const response = await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" });
    expect(response.status).toBe(503);
    expect(await readJson(response)).toEqual({ error: "Tilin luonti ei ole juuri nyt käytössä." });
    expect(await prisma.pendingSignup.count()).toBe(0);
  });

  it("applies the password rules and refuses cross-site posts", async () => {
    const weak = await start({ email: NEW_EMAIL, password: "lyhyt", firstName: "Uusi" });
    expect(weak.status).toBe(400);
    expect((await readJson(weak)).error).toMatch(/vähintään 8/);
    const crossSite = await signupStart(
      buildRequest(
        "POST",
        "/api/auth/signup/start",
        { email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" },
        { secFetchSite: "cross-site" }
      )
    );
    expect(crossSite.status).toBe(403);
    expect(await prisma.pendingSignup.count()).toBe(0);
  });

  it("ends a race with an account created meanwhile as 409", async () => {
    await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" });
    const code = codeIn(mailsTo(NEW_EMAIL)[0].subject);
    await createUser({ email: NEW_EMAIL });
    const response = await verify({ email: NEW_EMAIL, code });
    expect(response.status).toBe(409);
    expect((await readJson(response)).code).toBe("SIGNUP_EMAIL_TAKEN");
  });
});

describe("password reset by code", () => {
  async function requestReset(): Promise<string> {
    const response = await forgotPassword(
      buildRequest("POST", "/api/auth/password/forgot", { email: user.email })
    );
    expect(response.status).toBe(200);
    const [mail] = mailsTo(user.email);
    expect(mail.text).toContain("/palauta-salasana?token=");
    return codeIn(mail.text.replace(/token=\S+/, ""));
  }

  it("resets with email + code, revokes sessions and mails a notice", async () => {
    const code = await requestReset();
    await prisma.authSession.create({ data: { userId: user.id, label: "vanha" } });
    const response = await resetPassword(
      buildRequest("POST", "/api/auth/password/reset", {
        email: user.email.toUpperCase(),
        code,
        password: "palautettu-salasana",
      })
    );
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare("palautettu-salasana", row.passwordHash)).toBe(true);
    expect(await prisma.authSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    const tokenRow = await prisma.accountToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(tokenRow.usedAt).not.toBeNull();
    expect(JSON.stringify(tokenRow)).not.toContain(code);

    const notice = mailsTo(user.email).at(-1)!;
    expect(notice.text).toMatch(/^LashKirjan salasana vaihdettiin .+\. Jos se et ollut sinä: .+\/unohtunut-salasana/);

    const again = await resetPassword(
      buildRequest("POST", "/api/auth/password/reset", { email: user.email, code, password: "toinen-salasana" })
    );
    expect(again.status).toBe(410);
    expect((await readJson(again)).code).toBe("RESET_EXPIRED");
  });

  it("voids the reset after five wrong codes", async () => {
    const code = await requestReset();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await resetPassword(
        buildRequest("POST", "/api/auth/password/reset", { email: user.email, code: wrong, password: "uusi-salasana" })
      );
      expect(response.status).toBe(400);
      const body = await readJson(response);
      expect(body.code).toBe("RESET_CODE_INVALID");
      expect(body.attemptsLeft).toBe(5 - attempt);
    }
    const voided = await resetPassword(
      buildRequest("POST", "/api/auth/password/reset", { email: user.email, code, password: "uusi-salasana" })
    );
    expect(voided.status).toBe(410);
    expect((await readJson(voided)).code).toBe("RESET_EXPIRED");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(PASSWORD, row.passwordHash)).toBe(true);
  });

  it("refuses an expired code and an unknown address the same way", async () => {
    const code = await requestReset();
    await prisma.accountToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await resetPassword(
      buildRequest("POST", "/api/auth/password/reset", { email: user.email, code, password: "uusi-salasana" })
    );
    expect(expired.status).toBe(410);
    const unknown = await resetPassword(
      buildRequest("POST", "/api/auth/password/reset", { email: "ei-ole@example.com", code, password: "uusi-salasana" })
    );
    expect(unknown.status).toBe(410);
    expect(await readJson(unknown)).toEqual(await readJson(expired));
  });

  it("keeps the token path unchanged", async () => {
    const token = await issuePasswordReset(user.id);
    const reset = await resetPassword(
      buildRequest("POST", "/api/auth/password/reset", { token, password: "palautettu-salasana" })
    );
    expect(reset.status).toBe(200);
    expect(await readJson(reset)).toEqual({ ok: true });
    const reused = await resetPassword(
      buildRequest("POST", "/api/auth/password/reset", { token, password: "toinen-salasana-123" })
    );
    expect(reused.status).toBe(400);
    expect((await readJson(reused)).error).toBe("Linkki ei ole voimassa.");
    expect(mailsTo(user.email).at(-1)!.text).toMatch(/^LashKirjan salasana vaihdettiin/);
  });
});

describe("security notification mails", () => {
  it("mails the account after a password change", async () => {
    const cookie = await sessionCookie(user);
    const response = await changePasswordRoute(
      buildRequest(
        "POST",
        "/api/auth/password",
        { currentPassword: PASSWORD, newPassword: "vaihdettu-salasana" },
        { cookie }
      )
    );
    expect(response.status).toBe(200);
    const [notice] = mailsTo(user.email);
    expect(notice.text).toMatch(/^LashKirjan salasana vaihdettiin \d{1,2}\.\d{1,2}\.\d{4} klo \d{1,2}\.\d{2}\./);
    expect(notice.text).toContain("http://localhost:3000/unohtunut-salasana");
  });

  it("still changes the password when the notice cannot be sent", async () => {
    delete process.env.PLATFORM_SMTP_HOST;
    const cookie = await sessionCookie(user);
    const response = await changePasswordRoute(
      buildRequest(
        "POST",
        "/api/auth/password",
        { currentPassword: PASSWORD, newPassword: "vaihdettu-salasana" },
        { cookie }
      )
    );
    expect(response.status).toBe(200);
    expect(outbox.mails).toHaveLength(0);
  });

  it("mails the old address, masked, after an email change", async () => {
    const minted = await requestEmailChange(user.id, "uusi.osoite@example.com", PASSWORD);
    const response = await confirmEmail(
      buildRequest("POST", "/api/auth/email/confirm", { token: minted.token })
    );
    expect(response.status).toBe(200);
    expect(mailsTo("uusi.osoite@example.com")).toHaveLength(0);
    const [notice] = mailsTo(user.email);
    expect(notice.text).toMatch(/^Kirjautumissähköposti vaihdettiin osoitteeseen u\*+@example\.com\. Jos se et ollut sinä, ota yhteyttä tukeen/);
    expect(notice.text).not.toContain("uusi.osoite@");
  });
});
