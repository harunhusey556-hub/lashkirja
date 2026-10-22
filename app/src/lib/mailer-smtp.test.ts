import net from "net";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ prisma: {} }));

import { AppError } from "./api-errors";
import { encrypt } from "./encryption";
import { sendMail, sendPlatformMail, type MailSenderAccount } from "./mailer";

/**
 * Every other mail test runs the JSON transport, so none of them opens a
 * socket. This one speaks real SMTP to a local server so the nodemailer
 * client itself (greeting, EHLO, AUTH, envelope, DATA) is exercised.
 */
interface Delivery {
  auth: { user: string; pass: string } | null;
  from: string;
  to: string[];
  data: string;
}

let server: net.Server;
let port: number;
let rejectAuth: boolean;
const deliveries: Delivery[] = [];
const sockets = new Set<net.Socket>();
const socketErrors: Error[] = [];

function handleConnection(socket: net.Socket) {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", (error) => socketErrors.push(error));
  let buffer = "";
  let inData = false;
  let auth: Delivery["auth"] = null;
  let current: Delivery = { auth: null, from: "", to: [], data: "" };
  socket.write("220 smtp.test ESMTP\r\n");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) return;
        current.data = buffer.slice(0, end + 2).replace(/\r\n\.\./g, "\r\n.");
        current.auth = auth;
        buffer = buffer.slice(end + 5);
        inData = false;
        deliveries.push(current);
        current = { auth: null, from: "", to: [], data: "" };
        socket.write("250 2.0.0 queued\r\n");
        continue;
      }
      const eol = buffer.indexOf("\r\n");
      if (eol < 0) return;
      const line = buffer.slice(0, eol);
      buffer = buffer.slice(eol + 2);
      const verb = line.split(" ")[0].toUpperCase();
      if (verb === "EHLO") {
        socket.write("250-smtp.test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
      } else if (verb === "AUTH") {
        const [, user, pass] = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8").split("\0");
        if (rejectAuth) {
          socket.write("535 5.7.8 Authentication credentials invalid\r\n");
        } else {
          auth = { user, pass };
          socket.write("235 2.7.0 Authentication successful\r\n");
        }
      } else if (verb === "MAIL") {
        current.from = /<([^>]*)>/.exec(line)?.[1] ?? "";
        socket.write("250 2.1.0 OK\r\n");
      } else if (verb === "RCPT") {
        current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
        socket.write("250 2.1.5 OK\r\n");
      } else if (verb === "DATA") {
        inData = true;
        socket.write("354 go ahead\r\n");
      } else if (verb === "QUIT") {
        socket.end("221 2.0.0 bye\r\n");
      } else {
        socket.write("250 2.0.0 OK\r\n");
      }
    }
  });
}

beforeEach(async () => {
  rejectAuth = false;
  deliveries.length = 0;
  socketErrors.length = 0;
  vi.stubEnv("MAIL_TRANSPORT", "");
  server = net.createServer(handleConnection);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(socketErrors).toEqual([]);
});

function account(overrides: Partial<MailSenderAccount> = {}): MailSenderAccount {
  return {
    email: "kauppias@example.com",
    host: "imap.example.com",
    smtpHost: "127.0.0.1",
    smtpPort: port,
    encryptedPass: encrypt("sovellussalasana"),
    ...overrides,
  };
}

describe("sendMail over SMTP", () => {
  it("logs in with the mailbox credentials and delivers the invoice with its attachment", async () => {
    const pdf = Buffer.from("%PDF-1.4 testilasku");
    const sent = await sendMail(account(), {
      to: "asiakas@example.com",
      subject: "Lasku 1 – Ripsien pidennys",
      text: "Hei,\n\nliitteenä lasku. Kiitos!",
      attachments: [{ filename: "lasku-1.pdf", content: pdf, contentType: "application/pdf" }],
    });

    expect(sent.accepted).toEqual(["asiakas@example.com"]);
    expect(sent.messageId).toBeTruthy();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      auth: { user: "kauppias@example.com", pass: "sovellussalasana" },
      from: "kauppias@example.com",
      to: ["asiakas@example.com"],
    });
    const parsed = await simpleParser(deliveries[0].data);
    expect(parsed.subject).toBe("Lasku 1 – Ripsien pidennys");
    expect(parsed.text).toContain("liitteenä lasku");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("lasku-1.pdf");
    expect(parsed.attachments[0].content.equals(pdf)).toBe(true);
  });

  it("reports a refused login as a failed send", async () => {
    rejectAuth = true;

    const failure = await sendMail(account(), { to: "asiakas@example.com", subject: "Lasku 1", text: "Hei" }).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: "MAIL_SEND_FAILED", statusCode: 502 });
    expect((failure as AppError).message).toMatch(/^Sähköpostin lähetys epäonnistui: /);
    expect(deliveries).toEqual([]);
  });
});

describe("sendPlatformMail over SMTP", () => {
  it("delivers from the platform address without a login when no user is set", async () => {
    vi.stubEnv("PLATFORM_SMTP_HOST", "127.0.0.1");
    vi.stubEnv("PLATFORM_SMTP_PORT", String(port));
    vi.stubEnv("PLATFORM_SMTP_FROM", "no-reply@lashkirja.test");
    vi.stubEnv("PLATFORM_SMTP_USER", "");

    const sent = await sendPlatformMail({ to: "asiakas@example.com", subject: "Koodi", text: "123456" });

    expect(sent.accepted).toEqual(["asiakas@example.com"]);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ from: "no-reply@lashkirja.test", to: ["asiakas@example.com"], auth: null });
    expect((await simpleParser(deliveries[0].data)).text).toContain("123456");
  });
});
