import { createSign, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";

const JWT_TTL_SECONDS = 60 * 60;

export class EnableBankingNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnableBankingNotConfiguredError";
  }
}

export interface EnableBankingConfig {
  appId: string;
  privateKeyPem: string;
  redirectUrl: string;
  apiBase: string;
}

let cachedConfig: EnableBankingConfig | null = null;

export function clearEnableBankingConfigCache(): void {
  cachedConfig = null;
}

export function enableBankingEnabled(): boolean {
  const value = process.env.ENABLEBANKING_ENABLED?.trim().toLowerCase();
  return value === "true" || value === "1";
}

export function enableBankingStatus(): {
  enabled: boolean;
  ready: boolean;
  message?: string;
} {
  if (!enableBankingEnabled()) {
    return {
      enabled: false,
      ready: false,
      message: "Pankkiyhteys ei ole käytössä.",
    };
  }
  try {
    loadEnableBankingConfig();
    return { enabled: true, ready: true };
  } catch (error) {
    return {
      enabled: true,
      ready: false,
      message:
        error instanceof Error
          ? error.message
          : "Pankkiyhteyden asetukset ovat puutteelliset.",
    };
  }
}

export function loadEnableBankingConfig(): EnableBankingConfig {
  if (cachedConfig) return cachedConfig;
  if (!enableBankingEnabled()) {
    throw new EnableBankingNotConfiguredError("Pankkiyhteys ei ole käytössä.");
  }

  const appId = process.env.ENABLEBANKING_APP_ID?.trim();
  if (!appId) {
    throw new EnableBankingNotConfiguredError("ENABLEBANKING_APP_ID puuttuu.");
  }

  const redirectUrl = process.env.ENABLEBANKING_REDIRECT_URL?.trim();
  if (!redirectUrl || !isAbsoluteHttpUrl(redirectUrl)) {
    throw new EnableBankingNotConfiguredError(
      "ENABLEBANKING_REDIRECT_URL pitää olla täydellinen http- tai https-osoite."
    );
  }

  const apiBase = (
    process.env.ENABLEBANKING_API_BASE?.trim() || "https://api.enablebanking.com"
  ).replace(/\/+$/, "");
  if (!isAbsoluteHttpUrl(apiBase)) {
    throw new EnableBankingNotConfiguredError(
      "ENABLEBANKING_API_BASE pitää olla täydellinen http- tai https-osoite."
    );
  }

  cachedConfig = {
    appId,
    privateKeyPem: readPrivateKeyPem(),
    redirectUrl,
    apiBase,
  };
  return cachedConfig;
}

export function decodeKeyMaterial(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new EnableBankingNotConfiguredError(
      "Yksityinen avain puuttuu. Aseta ENABLEBANKING_KEY_FILE tai ENABLEBANKING_KEY_PEM."
    );
  }
  const withNewlines = trimmed.includes("BEGIN")
    ? trimmed.replace(/\\n/g, "\n")
    : Buffer.from(trimmed, "base64").toString("utf8").replace(/\\n/g, "\n");
  if (!withNewlines.includes("BEGIN")) {
    throw new EnableBankingNotConfiguredError(
      "ENABLEBANKING_KEY_PEM ei ole PEM-muotoinen yksityinen avain."
    );
  }
  return withNewlines.endsWith("\n") ? withNewlines : `${withNewlines}\n`;
}

export function signEnableBankingJwt(
  privateKeyPem: string,
  appId: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const header = { typ: "JWT", alg: "RS256", kid: appId };
  const payload = {
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: nowSeconds,
    exp: nowSeconds + JWT_TTL_SECONDS,
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return `${unsigned}.${base64Url(signature)}`;
}

export function decodeJwtPart<T>(token: string, index: number): T {
  const part = token.split(".")[index];
  if (!part) throw new Error("JWT-osa puuttuu");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
}

export function authorizationMatches(header: string | null, secret: string): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function readPrivateKeyPem(): string {
  const file = process.env.ENABLEBANKING_KEY_FILE?.trim();
  if (file) {
    try {
      return decodeKeyMaterial(fs.readFileSync(path.resolve(file), "utf8"));
    } catch (error) {
      if (error instanceof EnableBankingNotConfiguredError) throw error;
      throw new EnableBankingNotConfiguredError(
        "Yksityistä avainta ei voitu lukea. Tarkista ENABLEBANKING_KEY_FILE."
      );
    }
  }
  const inline = process.env.ENABLEBANKING_KEY_PEM?.trim();
  if (!inline) {
    throw new EnableBankingNotConfiguredError(
      "Yksityinen avain puuttuu. Aseta ENABLEBANKING_KEY_FILE tai ENABLEBANKING_KEY_PEM."
    );
  }
  return decodeKeyMaterial(inline);
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function base64Url(value: string | Buffer): string {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString("base64url");
}
