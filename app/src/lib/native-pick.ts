/**
 * Camera, photo library, and Files picks for the iOS shell.
 *
 * A browser keeps the plain file input. Inside Capacitor, the tap calls the
 * native plugin so the system permission dialog appears then, not from a
 * buried input. A missing plugin falls back to that input.
 */
import { Capacitor } from "@capacitor/core";
import { isPermissionDenied } from "@/lib/native-file-flow";

export type NativePick =
  | { kind: "files"; files: File[] }
  | { kind: "cancel" }
  | { kind: "denied"; message: string }
  | { kind: "unavailable" };

export const CAMERA_PERMISSION_DENIED =
  "Kameran käyttö estettiin. Salli kamera laitteen asetuksista, tai valitse kuva tiedostoista.";
export const PHOTO_PERMISSION_DENIED =
  "Kuvakirjaston käyttö estettiin. Voit sallia kaikki kuvat tai rajatun valinnan laitteen asetuksista.";
export const FILE_PICK_FAILED = "Tiedoston valinta ei onnistunut. Yritä uudelleen.";

export function isNativeShell(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** Full access and the iOS limited-library choice both allow a pick. */
export function permissionAllowsAccess(state: string | undefined): boolean {
  return state === "granted" || state === "limited";
}

export function classifyPickError(error: unknown): "cancel" | "denied" | "failed" {
  const text =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === "string"
        ? error
        : "";
  if (/cancel|canceled|dismiss/i.test(text)) return "cancel";
  if (isPermissionDenied(error)) return "denied";
  return "failed";
}

function mimeForFormat(format: string | undefined): string {
  const value = (format || "jpeg").toLowerCase();
  if (value === "png") return "image/png";
  if (value === "gif") return "image/gif";
  if (value === "heic" || value === "heif") return "image/heic";
  if (value === "pdf") return "application/pdf";
  return "image/jpeg";
}

function extensionForMime(mime: string, fallback: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/heic" || mime === "image/heif") return "heic";
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/jpeg") return "jpg";
  return fallback;
}

export function fileFromBase64(data: string, name: string, mime: string): File {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], name, { type: mime });
}

async function fileFromUrl(url: string, name: string, mime: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("file read failed");
  const blob = await response.blob();
  const type = mime || blob.type || "application/octet-stream";
  return new File([blob], name, { type });
}

function readableUrl(webPath?: string, uri?: string): string | null {
  if (webPath) return webPath;
  if (!uri) return null;
  try {
    return Capacitor.convertFileSrc(uri);
  } catch {
    return uri;
  }
}

async function mediaToFile(
  media: { webPath?: string; uri?: string; thumbnail?: string; metadata?: { format?: string } },
  fallbackName: string
): Promise<File | null> {
  const mime = mimeForFormat(media.metadata?.format);
  const name = fallbackName.includes(".")
    ? fallbackName
    : `${fallbackName}.${extensionForMime(mime, "jpg")}`;
  const url = readableUrl(media.webPath, media.uri);
  if (url) return fileFromUrl(url, name, mime);
  if (media.thumbnail) return fileFromBase64(media.thumbnail, name, mime);
  return null;
}

function deniedOr(error: unknown, message: string): NativePick {
  const kind = classifyPickError(error);
  if (kind === "cancel") return { kind: "cancel" };
  if (kind === "denied") return { kind: "denied", message };
  return { kind: "denied", message: FILE_PICK_FAILED };
}

export async function captureWithCamera(): Promise<NativePick> {
  if (!isNativeShell()) return { kind: "unavailable" };
  try {
    const { Camera } = await import("@capacitor/camera");
    const status = await Camera.requestPermissions({ permissions: ["camera"] });
    if (!permissionAllowsAccess(status.camera)) {
      return { kind: "denied", message: CAMERA_PERMISSION_DENIED };
    }
    const photo = await Camera.takePhoto({ quality: 90, includeMetadata: true });
    const file = await mediaToFile(photo, `kuitti-${Date.now()}`);
    if (!file) return { kind: "cancel" };
    return { kind: "files", files: [file] };
  } catch (error) {
    return deniedOr(error, CAMERA_PERMISSION_DENIED);
  }
}

export async function choosePhotoLibrary(): Promise<NativePick> {
  if (!isNativeShell()) return { kind: "unavailable" };
  try {
    const { Camera } = await import("@capacitor/camera");
    const status = await Camera.requestPermissions({ permissions: ["photos"] });
    if (!permissionAllowsAccess(status.photos)) {
      return { kind: "denied", message: PHOTO_PERMISSION_DENIED };
    }
    const picked = await Camera.chooseFromGallery({
      allowMultipleSelection: true,
      limit: 10,
      includeMetadata: true,
    });
    const files: File[] = [];
    for (const [index, media] of picked.results.entries()) {
      const file = await mediaToFile(media, `kuitti-${Date.now()}-${index + 1}`);
      if (file) files.push(file);
    }
    if (files.length === 0) return { kind: "cancel" };
    return { kind: "files", files };
  } catch (error) {
    return deniedOr(error, PHOTO_PERMISSION_DENIED);
  }
}

export async function chooseDocuments(types: string[]): Promise<NativePick> {
  if (!isNativeShell()) return { kind: "unavailable" };
  try {
    const { FilePicker } = await import("@capawesome/capacitor-file-picker");
    const picked = await FilePicker.pickFiles({ types, limit: 0 });
    const files: File[] = [];
    for (const entry of picked.files) {
      const mime = entry.mimeType || "application/octet-stream";
      const name = entry.name || `tiedosto.${extensionForMime(mime, "bin")}`;
      if (entry.data) {
        files.push(fileFromBase64(entry.data, name, mime));
        continue;
      }
      const url = readableUrl(entry.webPath, entry.path);
      if (!url) continue;
      files.push(await fileFromUrl(url, name, mime));
    }
    if (files.length === 0) return { kind: "cancel" };
    return { kind: "files", files };
  } catch (error) {
    return deniedOr(error, FILE_PICK_FAILED);
  }
}
