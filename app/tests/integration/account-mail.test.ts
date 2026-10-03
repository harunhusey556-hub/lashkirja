import { createHash } from "crypto";
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
import { GET as cronCleanup } from "@/app/api/cron/cleanup/route";
import { prisma } from "@/lib/db";
import {
  hashEmailCode,
  issuePasswordReset,
  notifyPasswordChanged,
  requestEmailChange,
  settleAccountMailForTests,
} from "@/lib/account-security";
import { readCredential } from "@/lib/auth-credential";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/**
 * Every platform mail the code under test composes, in order. While `hold` is
 * set, a send waits for it: an SMTP server that does not answer yet.
 */
const outbox = vi.hoisted(() => ({
  mails: [] as { to: string; subject: string; text: string }[],
  hold: null as Promise<void> | null,
}));

vi.mock("@/lib/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mailer")>();
  return {
    ...actual,
    sendPlatformMail: async (...args: Parameters<typeof actual.sendPlatformMail>) => {
      if (outbox.hold) await outbox.hold;
      const sent = await actual.sendPlatformMail(...args);
      outbox.mails.push({ to: args[0].to, subject: args[0].subject, text: args[0].text });
      return sent;
    },
  };
});

const PASSWORD = "salasana1234";
const NEW_EMAIL = "uusi.kayttaja@example.com";
const RESET_INVALID = { error: "Koodi ei kelpaa tai se on vanhentunut.", code: "RESET_CODE_INVALID" };
const HOUR = 60 * 60_000;

let user: TestUser;

function codeIn(text: string): string {
  const match = text.match(/\b(\d{6})\b/);
  if (!match) throw new Error(`no 6-digit code in: ${text}`);
  return match[1];
}

function mailsTo(address: string) {
  return outbox.mails.filter((mail) => mail.to === address);
}

function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

/** Background account mail (forgot, resend, notices) has finished. */
const settle = () => settleAccountMailForTests();

/** Resolves to "pending" when the response has not come within `ms`. */
async function answeredWithin(response: Promise<Response>, ms = 5000): Promise<Response | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  try {
    return await Promise.race([response, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Moves a guard's clock back, as if `ms` had passed. */
async function ageGuard(scope: string, ms: number) {
  const row = await prisma.accountCodeGuard.findUniqueOrThrow({ where: { scope } });
  await prisma.accountCodeGuard.update({
    where: { scope },
    data: {
      hourStart: new Date(row.hourStart.getTime() - ms),
      dayStart: new Date(row.dayStart.getTime() - ms),
      blockedUntil: row.blockedUntil && new Date(row.blockedUntil.getTime() - ms),
    },
  });
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
  await prisma.accountCodeGuard.deleteMany();
  outbox.mails.length = 0;
  outbox.hold = null;
  enableMail();
  process.env.SIGNUP_ENABLED = "true";
  user = await createUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(PASSWORD, 4) },
  });
});

afterEach(async () => {
  outbox.hold = null;
  await settle();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
    // Code first: the lock-screen notification shows it, and the first line copies alone.
    expect(mail.subject).toBe(`${code} on LashKirja-vahvistuskoodisi`);
    expect(mail.text.split(/\r?\n/)[0]).toBe(code);
    expect(mail.text).toContain("voimassa 15 minuuttia");
    // Only a hash of the code is stored, and the password is bcrypt.
    expect(JSON.stringify(pending)).not.toContain(code);
    expect(pending.passwordHash).not.toContain(PASSWORD);

    const verified = await verify({ email: NEW_EMAIL, code, password: PASSWORD, device: "ios-app" });
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

    const reused = await verify({ email: NEW_EMAIL, code, password: PASSWORD });
    expect(reused.status).toBe(410);
    expect(await prisma.accountCodeGuard.count()).toBe(0);
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
    const wrong = wrongCode(code);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await verify({ email: NEW_EMAIL, code: wrong, password: PASSWORD });
      expect(response.status).toBe(400);
      expect(await readJson(response)).toEqual({
        error: "Koodi ei kelpaa.",
        code: "SIGNUP_CODE_INVALID",
        attemptsLeft: 5 - attempt,
      });
    }
    const voided = await verify({ email: NEW_EMAIL, code, password: PASSWORD });
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
    const response = await verify({ email: NEW_EMAIL, code, password: PASSWORD });
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
    await settle();
    expect(mailsTo("ei-ole@example.com")).toHaveLength(0);

    const latest = codeIn(mailsTo(NEW_EMAIL).at(-1)!.subject);
    expect(mailsTo(NEW_EMAIL)).toHaveLength(3);
    if (latest !== first) {
      const stale = await verify({ email: NEW_EMAIL, code: first, password: PASSWORD });
      expect(stale.status).toBe(400);
    }
    expect((await verify({ email: NEW_EMAIL, code: latest, password: PASSWORD })).status).toBe(200);
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
      await verify({ email: NEW_EMAIL, code: "123456", password: PASSWORD }),
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
    const response = await verify({ email: NEW_EMAIL, code, password: PASSWORD });
    expect(response.status).toBe(409);
    expect((await readJson(response)).code).toBe("SIGNUP_EMAIL_TAKEN");
  });

  it("does not let a restarted sign-up take over the address (B1)", async () => {
    await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uhri" });
    // Someone else restarts the sign-up for the same address with their own password.
    await start({ email: NEW_EMAIL, password: "hyokkaajan-salasana", firstName: "Hyokkaaja" });
    const newest = codeIn(mailsTo(NEW_EMAIL).at(-1)!.subject);

    const victim = await verify({ email: NEW_EMAIL, code: newest, password: PASSWORD });
    expect(victim.status).toBe(400);
    expect(await readJson(victim)).toEqual({
      error: "Koodi ei kelpaa.",
      code: "SIGNUP_CODE_INVALID",
      attemptsLeft: 4,
    });
    const attacker = await verify({ email: NEW_EMAIL, code: wrongCode(newest), password: "hyokkaajan-salasana" });
    expect(attacker.status).toBe(400);
    expect(await readJson(attacker)).toEqual({
      error: "Koodi ei kelpaa.",
      code: "SIGNUP_CODE_INVALID",
      attemptsLeft: 3,
    });
    expect(await prisma.user.count({ where: { email: NEW_EMAIL } })).toBe(0);
  });

  it("new codes do not grant more than five guesses an hour (B2)", async () => {
    const scope = `signup:${NEW_EMAIL}`;
    const issue = [
      () => start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" }),
      () => resend({ email: NEW_EMAIL }),
      () => start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" }),
    ];
    const guesses = [2, 2, 1];
    for (let round = 0; round < issue.length; round += 1) {
      // Process-local limits forgotten: only the durable guard stands in the way.
      resetRateLimitsForTests();
      expect((await issue[round]()).status).toBe(200);
      await settle();
      const code = codeIn(mailsTo(NEW_EMAIL).at(-1)!.subject);
      for (let guess = 0; guess < guesses[round]; guess += 1) {
        expect((await verify({ email: NEW_EMAIL, code: wrongCode(code), password: PASSWORD })).status).toBe(400);
      }
    }
    resetRateLimitsForTests();
    await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" });
    const fresh = codeIn(mailsTo(NEW_EMAIL).at(-1)!.subject);
    const blocked = await verify({ email: NEW_EMAIL, code: fresh, password: PASSWORD });
    expect(blocked.status).toBe(400);
    expect(await readJson(blocked)).toEqual({
      error: "Koodi ei kelpaa.",
      code: "SIGNUP_CODE_INVALID",
      attemptsLeft: 0,
    });
    expect(await prisma.user.count({ where: { email: NEW_EMAIL } })).toBe(0);

    await ageGuard(scope, HOUR + 60_000);
    expect((await verify({ email: NEW_EMAIL, code: fresh, password: PASSWORD })).status).toBe(200);
    expect(await prisma.accountCodeGuard.count({ where: { scope } })).toBe(0);
  });

  it("ten failures in a day block for a day, across restarts (B2)", async () => {
    const scope = `signup:${NEW_EMAIL}`;
    async function failFive() {
      resetRateLimitsForTests();
      await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" });
      const code = codeIn(mailsTo(NEW_EMAIL).at(-1)!.subject);
      for (let guess = 0; guess < 5; guess += 1) {
        expect((await verify({ email: NEW_EMAIL, code: wrongCode(code), password: PASSWORD })).status).toBe(400);
      }
    }
    async function tryRightCode() {
      resetRateLimitsForTests();
      await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" });
      const code = codeIn(mailsTo(NEW_EMAIL).at(-1)!.subject);
      return verify({ email: NEW_EMAIL, code, password: PASSWORD });
    }
    await failFive();
    await ageGuard(scope, HOUR + 60_000);
    await failFive();
    const guard = await prisma.accountCodeGuard.findUniqueOrThrow({ where: { scope } });
    expect(guard.dayFailures).toBe(10);
    expect(guard.blockedUntil!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);

    // Two hours on, after a restart (in-memory limits gone), still blocked.
    await ageGuard(scope, 2 * HOUR);
    const stillBlocked = await tryRightCode();
    expect(stillBlocked.status).toBe(400);
    expect((await readJson(stillBlocked)).code).toBe("SIGNUP_CODE_INVALID");
    expect(await prisma.user.count({ where: { email: NEW_EMAIL } })).toBe(0);

    await ageGuard(scope, 23 * HOUR);
    expect((await tryRightCode()).status).toBe(200);
  });

  it("stores the code as an HMAC keyed from SESSION_SECRET", async () => {
    await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" });
    const code = codeIn(mailsTo(NEW_EMAIL)[0].subject);
    const row = await prisma.pendingSignup.findUniqueOrThrow({ where: { email: NEW_EMAIL } });
    const plain = createHash("sha256").update(`signup:${NEW_EMAIL}:${code}`).digest("hex");
    expect(row.codeHash).not.toBe(plain);
    expect(row.codeHash).toBe(hashEmailCode(`signup:${NEW_EMAIL}`, code));
    vi.stubEnv("SESSION_SECRET", "another-integration-secret-0123456789abcdef");
    expect(hashEmailCode(`signup:${NEW_EMAIL}`, code)).not.toBe(row.codeHash);
  });

  it("answers resend before the code mail is sent", async () => {
    await start({ email: NEW_EMAIL, password: PASSWORD, firstName: "Uusi" });
    let release!: () => void;
    outbox.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const answered = await answeredWithin(resend({ email: NEW_EMAIL }));
      expect(answered).not.toBe("pending");
      expect((answered as Response).status).toBe(200);
      expect(mailsTo(NEW_EMAIL)).toHaveLength(1);
    } finally {
      release();
    }
    await settle();
    expect(mailsTo(NEW_EMAIL)).toHaveLength(2);
  });

  it("the cleanup run deletes expired pending sign-ups and stale guards", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 10 * 60_000);
    const fields = { passwordHash: "x", firstName: "X", codeHash: "y" };
    await prisma.pendingSignup.create({ data: { email: "vanha@example.com", expiresAt: past, ...fields } });
    await prisma.pendingSignup.create({ data: { email: "tuore@example.com", expiresAt: future, ...fields } });
    const old = new Date(Date.now() - 25 * HOUR);
    await prisma.accountCodeGuard.create({ data: { scope: "signup:vanha@example.com", hourStart: old, dayStart: old } });
    await prisma.accountCodeGuard.create({
      data: { scope: "signup:estetty@example.com", hourStart: old, dayStart: old, blockedUntil: future },
    });
    await prisma.accountCodeGuard.create({ data: { scope: "signup:tuore@example.com" } });

    const response = await cronCleanup(buildRequest("GET", "/api/cron/cleanup"));
    expect(response.status).toBe(200);
    expect((await prisma.pendingSignup.findMany()).map((row) => row.email)).toEqual(["tuore@example.com"]);
    expect((await prisma.accountCodeGuard.findMany({ orderBy: { scope: "asc" } })).map((row) => row.scope)).toEqual([
      "signup:estetty@example.com",
      "signup:tuore@example.com",
    ]);
  });
});

describe("password reset by code", () => {
  function forgot(email: string) {
    return forgotPassword(buildRequest("POST", "/api/auth/password/forgot", { email }));
  }

  function reset(body: Record<string, unknown>) {
    return resetPassword(buildRequest("POST", "/api/auth/password/reset", body));
  }

  async function requestReset(): Promise<string> {
    const response = await forgot(user.email);
    expect(response.status).toBe(200);
    await settle();
    const mail = mailsTo(user.email).at(-1)!;
    expect(mail.text).toContain("/palauta-salasana?token=");
    const code = codeIn(mail.text.replace(/token=\S+/, ""));
    expect(mail.subject).toBe(`${code} on LashKirjan salasanan palautuskoodisi`);
    expect(mail.text.split(/\r?\n/)[0]).toBe(code);
    return code;
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
    expect(row.legacySessionsRevokedAt).not.toBeNull();
    expect(await prisma.authSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    const tokenRow = await prisma.accountToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(tokenRow.usedAt).not.toBeNull();
    expect(JSON.stringify(tokenRow)).not.toContain(code);

    await settle();
    const notice = mailsTo(user.email).at(-1)!;
    expect(notice.text).toMatch(/^LashKirjan salasana vaihdettiin .+\. Jos se et ollut sinä: .+\/unohtunut-salasana/);

    const again = await resetPassword(
      buildRequest("POST", "/api/auth/password/reset", { email: user.email, code, password: "toinen-salasana" })
    );
    expect(again.status).toBe(400);
    expect(await readJson(again)).toEqual(RESET_INVALID);
  });

  it("voids the reset after five wrong codes", async () => {
    const code = await requestReset();
    const wrong = wrongCode(code);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await reset({ email: user.email, code: wrong, password: "uusi-salasana" });
      expect(response.status).toBe(400);
      expect(await readJson(response)).toEqual(RESET_INVALID);
    }
    const voided = await reset({ email: user.email, code, password: "uusi-salasana" });
    expect(voided.status).toBe(400);
    expect(await readJson(voided)).toEqual(RESET_INVALID);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(PASSWORD, row.passwordHash)).toBe(true);
  });

  it("answers a missing user, no reset, expired, blocked and wrong code the same way", async () => {
    const answers: Response[] = [];
    answers.push(await reset({ email: "ei-ole@example.com", code: "123456", password: "uusi-salasana" }));
    answers.push(await reset({ email: user.email, code: "123456", password: "uusi-salasana" }));
    let code = await requestReset();
    answers.push(await reset({ email: user.email, code: wrongCode(code), password: "uusi-salasana" }));
    await prisma.accountToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    answers.push(await reset({ email: user.email, code, password: "uusi-salasana" }));
    code = await requestReset();
    await prisma.accountCodeGuard.update({
      where: { scope: `reset:${user.id}` },
      data: { blockedUntil: new Date(Date.now() + HOUR) },
    });
    answers.push(await reset({ email: user.email, code, password: "uusi-salasana" }));
    for (const answer of answers) {
      expect(answer.status).toBe(400);
      expect(await readJson(answer)).toEqual(RESET_INVALID);
    }
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(PASSWORD, row.passwordHash)).toBe(true);
  });

  it("new reset codes do not grant more than five guesses an hour (B2)", async () => {
    for (const guesses of [2, 2, 1]) {
      resetRateLimitsForTests();
      const code = await requestReset();
      for (let guess = 0; guess < guesses; guess += 1) {
        expect((await reset({ email: user.email, code: wrongCode(code), password: "uusi-salasana" })).status).toBe(400);
      }
    }
    resetRateLimitsForTests();
    const code = await requestReset();
    const blocked = await reset({ email: user.email, code, password: "uusi-salasana" });
    expect(blocked.status).toBe(400);
    expect(await readJson(blocked)).toEqual(RESET_INVALID);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(PASSWORD, row.passwordHash)).toBe(true);
  });

  it("two concurrent link resets: exactly one succeeds (B3)", async () => {
    const token = await issuePasswordReset(user.id);
    await prisma.authSession.create({ data: { userId: user.id, label: "vanha" } });
    const passwords = ["ensimmainen-salasana", "toinen-salasana-123"];
    const answers = await Promise.all(passwords.map((password) => reset({ token, password })));
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400]);
    const winner = passwords[answers.findIndex((answer) => answer.status === 200)];
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(winner, row.passwordHash)).toBe(true);
    expect(row.legacySessionsRevokedAt).not.toBeNull();
    expect(await prisma.authSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });

  it("answers forgot the same way and before the mail is sent", async () => {
    let release!: () => void;
    outbox.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const existing = await answeredWithin(forgot(user.email));
      const missing = await answeredWithin(forgot("ei-ole@example.com"));
      expect(existing).not.toBe("pending");
      expect(missing).not.toBe("pending");
      expect((existing as Response).status).toBe(200);
      expect(await readJson(existing as Response)).toEqual(await readJson(missing as Response));
      expect(mailsTo(user.email)).toHaveLength(0);
    } finally {
      release();
    }
    await settle();
    expect(mailsTo(user.email)).toHaveLength(1);
  });

  it("in production sends no reset link without APP_ORIGIN and queues recovery instead", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await forgot(user.email)).status).toBe(200);
    await settle();
    expect(mailsTo(user.email)).toHaveLength(0);
    expect(await prisma.accountRequest.count({ where: { userId: user.id, kind: "recovery" } })).toBe(1);

    vi.stubEnv("APP_ORIGIN", "https://lashkirja.example");
    resetRateLimitsForTests();
    const configured = await forgotPassword(
      buildRequest(
        "POST",
        "/api/auth/password/forgot",
        { email: user.email },
        { origin: "https://lashkirja.example" }
      )
    );
    expect(configured.status).toBe(200);
    await settle();
    expect(mailsTo(user.email).at(-1)!.text).toContain("https://lashkirja.example/palauta-salasana?token=");
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
    await settle();
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
    await settle();
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
    await settle();
    expect(outbox.mails).toHaveLength(0);
  });

  it("answers a password change before the notice is sent", async () => {
    const cookie = await sessionCookie(user);
    let release!: () => void;
    outbox.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const answered = await answeredWithin(
        changePasswordRoute(
          buildRequest(
            "POST",
            "/api/auth/password",
            { currentPassword: PASSWORD, newPassword: "vaihdettu-salasana" },
            { cookie }
          )
        )
      );
      expect(answered).not.toBe("pending");
      expect((answered as Response).status).toBe(200);
    } finally {
      release();
    }
    await settle();
    expect(mailsTo(user.email)).toHaveLength(1);
  });

  it("a failing notice lookup is logged and never thrown", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma.user, "findUnique").mockRejectedValueOnce(new Error("database is locked"));
    expect(() => notifyPasswordChanged(user.id, "http://localhost:3000")).not.toThrow();
    await settle();
    expect(logged).toHaveBeenCalled();
    expect(outbox.mails).toHaveLength(0);
  });

  it("mails the old address, masked, after an email change", async () => {
    const minted = await requestEmailChange(user.id, "uusi.osoite@example.com", PASSWORD);
    const response = await confirmEmail(
      buildRequest("POST", "/api/auth/email/confirm", { token: minted.token })
    );
    expect(response.status).toBe(200);
    await settle();
    expect(mailsTo("uusi.osoite@example.com")).toHaveLength(0);
    const [notice] = mailsTo(user.email);
    expect(notice.text).toMatch(/^Kirjautumissähköposti vaihdettiin osoitteeseen u\*+@example\.com\. Jos se et ollut sinä, ota yhteyttä tukeen/);
    expect(notice.text).not.toContain("uusi.osoite@");
  });
});
