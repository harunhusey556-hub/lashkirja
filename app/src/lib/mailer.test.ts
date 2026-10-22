import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transports = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      transports.options.push(options);
      return { sendMail: async () => ({ messageId: "<test@lashkirja>", accepted: ["asiakas@example.com"] }) };
    },
  },
}));
vi.mock("./db", () => ({ prisma: {} }));

import { encrypt } from "./encryption";
import { deriveSmtpHost, sendMail, smtpSecureForPort, type MailSenderAccount } from "./mailer";

function account(overrides: Partial<MailSenderAccount> = {}): MailSenderAccount {
  return {
    email: "kauppias@example.com",
    host: "imap.gmail.com",
    smtpHost: null,
    smtpPort: null,
    encryptedPass: encrypt("sovellussalasana"),
    ...overrides,
  };
}

const mail = { to: "asiakas@example.com", subject: "Lasku 1", text: "Hei" };

beforeEach(() => {
  transports.options.length = 0;
  vi.stubEnv("MAIL_TRANSPORT", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deriveSmtpHost", () => {
  // The incoming hosts the web settings and the iOS app offer (MailProvider).
  it.each([
    ["Gmail", "imap.gmail.com", "smtp.gmail.com"],
    ["iCloud", "imap.mail.me.com", "smtp.mail.me.com"],
    // outlook.office365.com has no imap. prefix and is not an SMTP server.
    ["Outlook / Hotmail", "outlook.office365.com", "smtp-mail.outlook.com"],
  ])("gives the %s preset its real outgoing host", (_preset, imapHost, smtpHost) => {
    expect(deriveSmtpHost(imapHost)).toBe(smtpHost);
  });

  it("ignores the case of the typed host", () => {
    expect(deriveSmtpHost("Outlook.Office365.com")).toBe("smtp-mail.outlook.com");
  });

  it("keeps a host it does not recognise", () => {
    expect(deriveSmtpHost("mail.example.fi")).toBe("mail.example.fi");
    expect(deriveSmtpHost("posti.example.fi")).toBe("posti.example.fi");
  });

  it("does not read inherited object keys as providers", () => {
    expect(deriveSmtpHost("constructor")).toBe("constructor");
  });
});

describe("smtpSecureForPort", () => {
  it("uses implicit TLS on 465 and STARTTLS elsewhere", () => {
    expect(smtpSecureForPort(465)).toBe(true);
    expect(smtpSecureForPort(587)).toBe(false);
  });
});

describe("sendMail transport", () => {
  it("sends the Outlook preset through smtp-mail.outlook.com on 587 with STARTTLS", async () => {
    await sendMail(account({ host: "outlook.office365.com", email: "kauppias@hotmail.com" }), mail);

    expect(transports.options).toEqual([
      {
        host: "smtp-mail.outlook.com",
        port: 587,
        secure: false,
        auth: { user: "kauppias@hotmail.com", pass: "sovellussalasana" },
      },
    ]);
  });

  it("sends the Gmail preset through smtp.gmail.com", async () => {
    await sendMail(account(), mail);

    expect(transports.options[0]).toMatchObject({ host: "smtp.gmail.com", port: 587, secure: false });
  });

  it("lets an explicit smtpHost and port win over the derived host", async () => {
    await sendMail(account({ host: "outlook.office365.com", smtpHost: "smtp.office365.com", smtpPort: 465 }), mail);

    expect(transports.options[0]).toMatchObject({ host: "smtp.office365.com", port: 465, secure: true });
  });
});
