import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

const isProduction = process.env.NODE_ENV === "production";
const configuredSecret = process.env.SESSION_SECRET?.trim();
const developmentSecret = "lashkirja-local-development-only-secret-32-chars";

const rawSecret = configuredSecret || developmentSecret;

// Ensure we have exactly a 32-byte key for AES-256-GCM
const ENCRYPTION_KEY = createHash("sha256").update(rawSecret).digest();

/**
 * Symmetrically encrypts a string (e.g. App Password) using AES-256-GCM.
 * Returns a payload formatted as `iv.encryptedText.authTag` (hex).
 */
export function encrypt(text: string): string {
  const iv = randomBytes(12); // 96-bit IV is standard for GCM
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}.${encrypted}.${authTag}`;
}

/**
 * Decrypts a previously encrypted string.
 */
export function decrypt(encryptedData: string): string {
  const parts = encryptedData.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format");
  }

  const [ivHex, encryptedHex, authTagHex] = parts;
  
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  
  return decrypted;
}
