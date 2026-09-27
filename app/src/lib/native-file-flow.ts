export type PickPermission = "granted" | "denied" | "unknown";

export type FilePickDecision =
  | { kind: "upload" }
  | { kind: "ignore" }
  | { kind: "denied"; message: string };

export const CAMERA_DENIED_MESSAGE =
  "Kameran tai tiedostojen käyttö estettiin. Voit valita kuvan tiedostoista tai sallia käytön laitteen asetuksista.";

/**
 * A web file input reports cancel and a denied camera the same way: no files.
 * Only an explicit permission error is explained. Cancel stays quiet.
 */
export function filePickDecision(fileCount: number, permission: PickPermission = "unknown"): FilePickDecision {
  if (permission === "denied") {
    return { kind: "denied", message: CAMERA_DENIED_MESSAGE };
  }
  if (fileCount === 0) return { kind: "ignore" };
  return { kind: "upload" };
}

export function isPermissionDenied(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === "string"
        ? error
        : "";
  return /denied|permission|not allowed|eacces/i.test(text);
}

/** In-app paths stay in the webview. Everything else leaves for the system. */
export function externalLinkKind(href: string): "in-app" | "leaves-app" {
  if (href.startsWith("/") && !href.startsWith("//")) return "in-app";
  return "leaves-app";
}
