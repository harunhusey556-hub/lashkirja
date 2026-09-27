/**
 * Outgoing mail for sales invoices.
 *
 * Credentials are reused from the IMAP account the user already connected, so
 * sending needs no second login. Nothing is sent unless an account exists -
 * the route reports that instead of silently doing nothing.
 */
import nodemailer from "nodemailer";
import { prisma } from "./db";
import { decrypt } from "./encryption";
import { AppError } from "./api-errors";

export interface OutgoingAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  attachments?: OutgoingAttachment[];
}

export interface SentMail {
  messageId: string;
  from: string;
  to: string;
  accepted: string[];
  /** Present only under the test transport; lets tests read what was composed. */
  raw?: string;
}

/**
 * imap.gmail.com -> smtp.gmail.com. Anything unrecognised keeps the host, and
 * the user can always set smtpHost explicitly.
 */
export function deriveSmtpHost(imapHost: string): string {
  if (/^imap\./i.test(imapHost)) return imapHost.replace(/^imap\./i, "smtp.");
  if (/^mail\./i.test(imapHost)) return imapHost;
  return imapHost;
}

/** 465 is implicit TLS; 587 is STARTTLS. */
export function smtpSecureForPort(port: number): boolean {
  return port === 465;
}

export interface MailSenderAccount {
  email: string;
  host: string;
  smtpHost: string | null;
  smtpPort: number | null;
  encryptedPass: string;
}

export async function findSenderAccount(userId: string): Promise<MailSenderAccount | null> {
  const account = await prisma.imapAccount.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { email: true, host: true, smtpHost: true, smtpPort: true, encryptedPass: true },
  });
  return account;
}

export async function sendMail(
  account: MailSenderAccount,
  mail: OutgoingMail
): Promise<SentMail> {
  // The test transport composes the message and hands it back instead of
  // opening a socket, so delivery can be asserted without a mail server.
  const useJsonTransport = process.env.MAIL_TRANSPORT === "json";

  const transporter = useJsonTransport
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
        host: account.smtpHost || deriveSmtpHost(account.host),
        port: account.smtpPort ?? 587,
        secure: smtpSecureForPort(account.smtpPort ?? 587),
        auth: { user: account.email, pass: decrypt(account.encryptedPass) },
      });

  try {
    const info = await transporter.sendMail({
      from: account.email,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      attachments: mail.attachments,
    });

    return {
      messageId: info.messageId,
      from: account.email,
      to: mail.to,
      accepted: (info.accepted ?? []).map(String),
      raw: useJsonTransport ? (info as unknown as { message: string }).message : undefined,
    };
  } catch (error) {
    throw new AppError(
      `Sähköpostin lähetys epäonnistui: ${
        error instanceof Error ? error.message : "tuntematon virhe"
      }`,
      "MAIL_SEND_FAILED",
      502
    );
  }
}

/** App mail that does not use the customer's invoice mailbox. */
export interface PlatformMailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export function platformMailConfig(
  env: NodeJS.ProcessEnv = process.env
): PlatformMailConfig | null {
  const host = env.PLATFORM_SMTP_HOST?.trim() ?? "";
  const from = env.PLATFORM_SMTP_FROM?.trim() ?? "";
  if (!host || !from) return null;
  const parsed = Number(env.PLATFORM_SMTP_PORT || 587);
  const port = Number.isFinite(parsed) && parsed > 0 ? parsed : 587;
  return {
    host,
    port,
    user: env.PLATFORM_SMTP_USER?.trim() ?? "",
    pass: env.PLATFORM_SMTP_PASS ?? "",
    from,
  };
}

/** Sends with PLATFORM_SMTP_*. Uses the JSON transport when MAIL_TRANSPORT=json. */
export async function sendPlatformMail(mail: OutgoingMail): Promise<SentMail> {
  const config = platformMailConfig();
  if (!config) {
    throw new AppError("Alustan postia ei ole määritetty.", "PLATFORM_MAIL_MISSING", 503);
  }
  const useJsonTransport = process.env.MAIL_TRANSPORT === "json";
  const transporter = useJsonTransport
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: smtpSecureForPort(config.port),
        auth: config.user ? { user: config.user, pass: config.pass } : undefined,
      });
  const info = await transporter.sendMail({
    from: config.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    attachments: mail.attachments,
  });
  return {
    messageId: info.messageId,
    from: config.from,
    to: mail.to,
    accepted: (info.accepted ?? []).map(String),
    raw: useJsonTransport ? (info as unknown as { message: string }).message : undefined,
  };
}
