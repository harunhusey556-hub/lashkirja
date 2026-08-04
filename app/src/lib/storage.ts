import { createHash, randomUUID } from "crypto";
import { constants as fsConstants, existsSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";

export const MAX_RECEIPT_BYTES = 15 * 1024 * 1024;
export const MAX_STATEMENT_BYTES = 20 * 1024 * 1024;

export type UploadPurpose = "receipt" | "statement";

export interface DetectedFile {
  extension: string;
  mimeType: string;
  kind: "pdf" | "jpeg" | "png" | "gif" | "webp" | "heic" | "xml" | "csv" | "xlsx" | "xls";
}

const RECEIPT_KINDS = new Set(["pdf", "jpeg", "png", "heic"]);
const STATEMENT_KINDS = new Set(["pdf", "xml", "csv", "xlsx", "xls"]);

function startsWith(buffer: Buffer, signature: number[]): boolean {
  return signature.every((byte, index) => buffer[index] === byte);
}

function detectFile(buffer: Buffer): DetectedFile | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { extension: ".pdf", mimeType: "application/pdf", kind: "pdf" };
  }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return { extension: ".jpg", mimeType: "image/jpeg", kind: "jpeg" };
  }
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { extension: ".png", mimeType: "image/png", kind: "png" };
  }
  const prefix = buffer.subarray(0, 12).toString("ascii");
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) {
    return { extension: ".gif", mimeType: "image/gif", kind: "gif" };
  }
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") {
    return { extension: ".webp", mimeType: "image/webp", kind: "webp" };
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii").toLowerCase();
    if (["heic", "heix", "hevc", "hevx", "heif", "mif1", "msf1"].includes(brand)) {
      return { extension: ".heic", mimeType: "image/heic", kind: "heic" };
    }
  }
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    return { extension: ".xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "xlsx" };
  }
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { extension: ".xls", mimeType: "application/vnd.ms-excel", kind: "xls" };
  }

  if (buffer.includes(0)) return null;
  const text = buffer.subarray(0, Math.min(buffer.length, 8192)).toString("utf8");
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  if (trimmed.startsWith("<?xml") || /^<(Document|[A-Za-z]+:Document)\b/.test(trimmed)) {
    return { extension: ".xml", mimeType: "application/xml", kind: "xml" };
  }
  if (text.includes("\n") && (text.includes(";") || text.includes(","))) {
    return { extension: ".csv", mimeType: "text/csv", kind: "csv" };
  }
  return null;
}

export function validateUploadBuffer(
  buffer: Buffer,
  originalName: string,
  purpose: UploadPurpose
): DetectedFile {
  const maximum = purpose === "receipt" ? MAX_RECEIPT_BYTES : MAX_STATEMENT_BYTES;
  if (buffer.length === 0 || buffer.length > maximum) {
    throw new UploadValidationError(buffer.length === 0 ? "Tiedosto on tyhjä" : "Tiedosto on liian suuri", 413);
  }
  const detected = detectFile(buffer);
  const allowed = purpose === "receipt" ? RECEIPT_KINDS : STATEMENT_KINDS;
  if (!detected || !allowed.has(detected.kind)) {
    throw new UploadValidationError("Tiedostomuotoa ei tueta", 415);
  }

  const suppliedExt = path.extname(originalName).toLowerCase();
  const acceptable = detected.kind === "jpeg"
    ? new Set([".jpg", ".jpeg"])
    : detected.kind === "heic"
      ? new Set([".heic", ".heif"])
      : new Set([detected.extension]);
  if (!acceptable.has(suppliedExt)) {
    throw new UploadValidationError("Tiedoston sisältö ja tiedostopääte eivät vastaa toisiaan", 415);
  }
  return detected;
}

export class UploadValidationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function uploadsRoot(): string {
  return path.join(process.cwd(), "data", "uploads");
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Unsafe storage segment");
  return value;
}

function safeStorageKey(value: string): string {
  if (!/^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/.test(value)) throw new Error("Unsafe storage key");
  return value;
}

export async function ensurePrivateUploadDirectories(userId: string): Promise<string> {
  const root = uploadsRoot();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const userDir = path.join(root, safeSegment(userId));
  await fs.mkdir(userDir, { recursive: true, mode: 0o700 });
  await fs.chmod(userDir, 0o700);
  return userDir;
}

export async function writePrivateUpload(
  userId: string,
  extension: string,
  buffer: Buffer
): Promise<{ storageKey: string; absolutePath: string }> {
  const userDir = await ensurePrivateUploadDirectories(userId);
  const storageKey = safeStorageKey(`${randomUUID()}${extension}`);
  const absolutePath = path.join(userDir, storageKey);
  const handle = await fs.open(absolutePath, "wx", 0o600);
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(absolutePath, 0o600);
  return { storageKey, absolutePath };
}

async function readNoFollow(absolutePath: string): Promise<Buffer> {
  const handle = await fs.open(
    absolutePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Stored object is not a regular file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readUserUpload(
  userId: string,
  storageKey: string,
  allowLegacy = false
): Promise<Buffer> {
  const safeKey = safeStorageKey(storageKey);
  const userPath = path.join(uploadsRoot(), safeSegment(userId), safeKey);
  try {
    return await readNoFollow(userPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!allowLegacy || code !== "ENOENT") throw error;
    return readNoFollow(path.join(uploadsRoot(), safeKey));
  }
}

export async function removeUserUpload(
  userId: string,
  storageKey: string,
  allowLegacy = false
): Promise<void> {
  const safeKey = safeStorageKey(storageKey);
  const candidates = [path.join(uploadsRoot(), safeSegment(userId), safeKey)];
  if (allowLegacy) candidates.push(path.join(uploadsRoot(), safeKey));
  for (const candidate of candidates) {
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error("Refusing to remove symlinked upload");
      if (!stat.isFile()) throw new Error("Stored object is not a regular file");
      await fs.unlink(candidate);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function resolveUserUploadPath(
  userId: string,
  storageKey: string,
  allowLegacy = false
): string {
  const userPath = path.join(uploadsRoot(), safeSegment(userId), safeStorageKey(storageKey));
  if (!allowLegacy) return userPath;
  if (existsSync(userPath)) return userPath;
  return path.join(uploadsRoot(), safeStorageKey(storageKey));
}

export async function removeDerivedHeicJpeg(absolutePath: string): Promise<void> {
  if (!/\.(heic|heif)$/i.test(absolutePath)) return;
  const derived = absolutePath.replace(/\.(heic|heif)$/i, ".jpg");
  try {
    const stat = await fs.lstat(derived);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    await fs.unlink(derived);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function safeOriginalName(value: string): string {
  const base = path.basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || "tiedosto").slice(0, 255);
}

export function inlineContentDisposition(value: string): string {
  const fallback = safeOriginalName(value).replace(/[^A-Za-z0-9._-]/g, "_");
  const encoded = encodeURIComponent(safeOriginalName(value)).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

