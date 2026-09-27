export type ShareResult = "shared" | "downloaded" | "cancelled" | "unavailable";

export type ShareInput = {
  title: string;
  text?: string;
  url?: string;
  file?: File;
};

export interface NativeShareOptions {
  title?: string;
  text?: string;
  url?: string;
  files?: string[];
  dialogTitle?: string;
}

/** Test seam. Production uses the Capacitor share sheet and a cache file URI. */
export interface ShareRuntime {
  isNativePlatform: () => boolean;
  share: (options: NativeShareOptions) => Promise<unknown>;
  fileUri: (file: File) => Promise<string | null>;
  canShareFiles: (file: File) => boolean;
  webShare: (data: ShareData) => Promise<void>;
  download: (file: File) => boolean;
}

type ShareNavigator = Navigator & {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
};

/**
 * Share a file or a short text. Prefers the platform share sheet
 * (Web Share, which Capacitor's WKWebView uses, then the Capacitor Share
 * plugin when the app is installed as a native shell). Falls back to a
 * download so the action still does something on desktop.
 *
 * When a file is required, success means the file bytes were attached.
 * A title, text or URL share is not reported as success in that case.
 */
export async function shareContent(
  input: ShareInput,
  runtime?: Partial<ShareRuntime>
): Promise<ShareResult> {
  const canShareFiles = runtime?.canShareFiles ?? defaultCanShareFiles;
  const webShare = runtime?.webShare ?? defaultWebShare;

  try {
    if (input.file && webShare && canShareFiles(input.file)) {
      await webShare({ title: input.title, text: input.text, files: [input.file] });
      return "shared";
    }
  } catch (error) {
    if (isAbort(error)) return "cancelled";
  }

  const sharedNatively = await shareWithCapacitor(input, runtime);
  if (sharedNatively === "shared" || sharedNatively === "cancelled") return sharedNatively;

  // A required file must not be reported as shared via title, text or URL only.
  if (!input.file && webShare && (input.url || input.text)) {
    try {
      await webShare({ title: input.title, text: input.text, url: input.url });
      return "shared";
    } catch (error) {
      if (isAbort(error)) return "cancelled";
    }
  }

  if (input.file) {
    const download = runtime?.download ?? defaultDownload;
    if (download(input.file)) return "downloaded";
  }

  return "unavailable";
}

export async function shareWithCapacitor(
  input: ShareInput,
  runtime?: Partial<ShareRuntime>
): Promise<ShareResult | null> {
  try {
    if (runtime?.isNativePlatform) {
      if (!runtime.isNativePlatform()) return null;
    } else {
      const { Capacitor } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform()) return null;
    }
    const share = runtime?.share ?? defaultNativeShare;
    const fileUri = runtime?.fileUri ?? fileUriFromFilesystem;

    if (input.file) {
      const uri = await fileUri(input.file);
      if (!uri) return null;
      await share({
        title: input.title,
        text: input.text,
        files: [uri],
        dialogTitle: input.title,
      });
      return "shared";
    }

    await share({
      title: input.title,
      text: input.text,
      url: input.url,
      dialogTitle: input.title,
    });
    return "shared";
  } catch (error) {
    if (isAbort(error)) return "cancelled";
    return null;
  }
}

async function defaultNativeShare(options: NativeShareOptions): Promise<unknown> {
  const { Share } = await import("@capacitor/share");
  return Share.share(options);
}

function defaultCanShareFiles(file: File): boolean {
  const nav = navigator as ShareNavigator;
  return Boolean(nav.canShare?.({ files: [file] }) && nav.share);
}

function defaultWebShare(data: ShareData): Promise<void> {
  const nav = navigator as ShareNavigator;
  if (!nav.share) return Promise.reject(new Error("share unavailable"));
  return nav.share(data);
}

function defaultDownload(file: File): boolean {
  if (typeof document === "undefined") return false;
  const href = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = href;
  link.download = file.name;
  link.click();
  URL.revokeObjectURL(href);
  return true;
}

async function fileUriFromFilesystem(file: File): Promise<string | null> {
  try {
    const { Directory, Filesystem } = await import("@capacitor/filesystem");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    const written = await Filesystem.writeFile({
      path: `share/${Date.now()}-${safeShareName(file.name)}`,
      data: btoa(binary),
      directory: Directory.Cache,
      recursive: true,
    });
    return written.uri || null;
  } catch {
    return null;
  }
}

function safeShareName(name: string): string {
  const cleaned = name.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 80) || "tiedosto.pdf";
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "message" in error &&
      String((error as { message: unknown }).message).toLowerCase().includes("cancel"))
  );
}
