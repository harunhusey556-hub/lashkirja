import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { completeAccountClose, completeAccountExport, setAccountRequestStatus } from "@/lib/account-requests";
import { CLOSED_LOGIN_MESSAGE } from "@/lib/account-copy";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";

/**
 * The Tietosuoja page and the close dialog promise "Tuki ilmoittaa sinulle
 * sähköpostilla". These tests read what the platform mailbox was handed.
 */
const outbox = vi.hoisted(() => ({
  mails: [] as { to: string; subject: string; text: string }[],
  failing: false,
}));

vi.mock("@/lib/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mailer")>();
  return {
    ...actual,
    sendPlatformMail: async (...args: Parameters<typeof actual.sendPlatformMail>) => {
      if (outbox.failing) throw new Error("smtp down");
      const sent = await actual.sendPlatformMail(...args);
      outbox.mails.push({ to: args[0].to, subject: args[0].subject, text: args[0].text });
      return sent;
    },
  };
});

let user: TestUser;

function enableMail() {
  process.env.PLATFORM_SMTP_HOST = "smtp.test.invalid";
  process.env.PLATFORM_SMTP_FROM = "no-reply@test.invalid";
  process.env.MAIL_TRANSPORT = "json";
}

function openRequest(kind: "close" | "export" | "recovery") {
  return prisma.accountRequest.create({ data: { userId: user.id, kind, status: "pending" } });
}

beforeEach(async () => {
  await resetDatabase();
  outbox.mails.length = 0;
  outbox.failing = false;
  enableMail();
  user = await createUser();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PLATFORM_SMTP_HOST;
  delete process.env.PLATFORM_SMTP_FROM;
  delete process.env.MAIL_TRANSPORT;
});

describe("a decided close or copy request mails the user", () => {
  it("says the copy is ready and where to get it", async () => {
    const request = await openRequest("export");
    await completeAccountExport(request.id);

    expect(outbox.mails).toHaveLength(1);
    expect(outbox.mails[0]).toMatchObject({ to: user.email, subject: "LashKirjan tietokopio on valmis" });
    expect(outbox.mails[0].text).toContain("Asetukset > Tietosuoja");
  });

  it("says the account is closed, from the platform mailbox because the user's own is purged", async () => {
    await prisma.imapAccount.create({
      data: { userId: user.id, email: "oma@example.com", host: "imap.example.com", encryptedPass: "x.y.z" },
    });
    const request = await openRequest("close");
    await completeAccountClose(request.id);

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).accessDisabledAt).not.toBeNull();
    expect(outbox.mails).toHaveLength(1);
    expect(outbox.mails[0]).toMatchObject({ to: user.email, subject: "LashKirjan tili on suljettu" });
    expect(outbox.mails[0].text).toContain("Tilin sulkemispyyntösi on käsitelty.");
    expect(outbox.mails[0].text).toContain(CLOSED_LOGIN_MESSAGE);
  });

  it("gives the reason when a request is denied", async () => {
    const request = await openRequest("close");
    await setAccountRequestStatus(request.id, "denied", "Tilillä on avoin kuukausi");

    expect(outbox.mails).toHaveLength(1);
    expect(outbox.mails[0].to).toBe(user.email);
    expect(outbox.mails[0].text).toContain("Tilin sulkemispyyntöäsi ei voitu toteuttaa.");
    expect(outbox.mails[0].text).toContain("Syy: Tilillä on avoin kuukausi");
    expect(outbox.mails[0].text).toContain("ota yhteyttä tukeen");
  });

  it("names the missing information when a request needs more", async () => {
    const request = await openRequest("export");
    await setAccountRequestStatus(request.id, "needs_info", "Vahvista y-tunnus");

    expect(outbox.mails).toHaveLength(1);
    expect(outbox.mails[0].subject).toBe("LashKirja tarvitsee lisätietoa pyyntöösi");
    expect(outbox.mails[0].text).toContain("Puuttuva tieto: Vahvista y-tunnus");
  });

  it("leaves the note of an earlier step out of a later decision", async () => {
    const request = await openRequest("export");
    await setAccountRequestStatus(request.id, "needs_info", "Vahvista y-tunnus");
    outbox.mails.length = 0;
    await setAccountRequestStatus(request.id, "denied");

    expect(outbox.mails).toHaveLength(1);
    expect(outbox.mails[0].text).not.toContain("Vahvista y-tunnus");
    expect(outbox.mails[0].text).not.toContain("Syy:");
  });

  it("sends nothing for a step that decides nothing, or for a recovery row", async () => {
    const copy = await openRequest("export");
    await setAccountRequestStatus(copy.id, "in_progress");
    const recovery = await openRequest("recovery");
    await setAccountRequestStatus(recovery.id, "completed");

    expect(outbox.mails).toEqual([]);
  });
});

describe("a mail that cannot go out never undoes the decision", () => {
  it("completes the request and warns support when no mail path exists", async () => {
    delete process.env.PLATFORM_SMTP_HOST;
    delete process.env.PLATFORM_SMTP_FROM;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = await openRequest("export");

    const done = await completeAccountExport(request.id);

    expect(done.status).toBe("completed");
    expect(outbox.mails).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(request.id);
  });

  it("completes the request and warns support when the platform mailbox fails", async () => {
    outbox.failing = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = await openRequest("close");

    const done = await completeAccountClose(request.id);

    expect(done.status).toBe("completed");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(request.id);
  });
});
