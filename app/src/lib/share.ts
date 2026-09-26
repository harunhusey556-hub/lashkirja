export type ShareResult = "shared" | "downloaded" | "cancelled" | "unavailable";

type ShareInput = {
  title: string;
  text?: string;
  url?: string;
  file?: File;
};

type ShareNavigator = Navigator & {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
};

/**
 * Share a file or a short text. Prefers the platform share sheet
 * (Web Share, which Capacitor's WKWebView uses, then the Capacitor Share
 * plugin when the app is installed as a native shell). Falls back to a
 * download so the action still does something on desktop.
 */
export async function shareContent(input: ShareInput): Promise<ShareResult> {
  const nav = navigator as ShareNavigator;

  try {
    if (input.file && nav.canShare?.({ files: [input.file] }) && nav.share) {
      await nav.share({ title: input.title, text: input.text, files: [input.file] });
      return "shared";
    }
  } catch (error) {
    if (isAbort(error)) return "cancelled";
  }

  const sharedNatively = await shareWithCapacitor(input);
  if (sharedNatively === "shared" || sharedNatively === "cancelled") return sharedNatively;

  try {
    if (nav.share && (input.url || input.text)) {
      await nav.share({ title: input.title, text: input.text, url: input.url });
      return "shared";
    }
  } catch (error) {
    if (isAbort(error)) return "cancelled";
  }

  if (input.file) {
    const href = URL.createObjectURL(input.file);
    const link = document.createElement("a");
    link.href = href;
    link.download = input.file.name;
    link.click();
    URL.revokeObjectURL(href);
    return "downloaded";
  }

  return "unavailable";
}

async function shareWithCapacitor(input: ShareInput): Promise<ShareResult | null> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) return null;
    const { Share } = await import("@capacitor/share");
    await Share.share({
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

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "message" in error &&
      String((error as { message: unknown }).message).toLowerCase().includes("cancel"))
  );
}
