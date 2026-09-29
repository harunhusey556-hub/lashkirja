import { showToast } from "@/lib/toast";

/**
 * "Kopioi" for identifiers and values (AX-07, R25): IBAN, viitenumero,
 * Y-tunnus, invoice number. Copies from the user's tap (the WebView needs
 * that gesture), confirms with a "Kopioitu" toast and a success haptic.
 * Never throws; a refused clipboard shows an error toast instead.
 */
export async function copyToClipboard(text: string, what: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
    // A success toast carries the success haptic itself.
    showToast({ tone: "success", text: `${what} kopioitu` });
    return true;
  } catch {
    showToast({ tone: "error", text: "Kopiointi ei onnistunut. Paina arvoa pitkään ja valitse Kopioi." });
    return false;
  }
}
