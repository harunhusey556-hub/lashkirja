/** Shared account rules with no database and no Node-only imports. */

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 1024;

/** Finnish accounting material is kept six years after the financial year ends. */
export const ACCOUNTING_RETENTION_YEARS = 6;

export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) {
    return `Salasanassa on oltava vähintään ${PASSWORD_MIN} merkkiä.`;
  }
  if (password.length > PASSWORD_MAX) return "Salasana on liian pitkä.";
  return null;
}

/** A short device name stored on the session row. The raw user agent is not kept. */
export function deviceLabel(userAgent: string | null | undefined, appDevice?: "ios-app"): string {
  if (appDevice === "ios-app") return "iPhone · LashKirja-sovellus";
  const ua = userAgent || "";
  const device = /iPhone/i.test(ua)
    ? "iPhone"
    : /iPad/i.test(ua)
      ? "iPad"
      : /Android/i.test(ua)
        ? "Android"
        : /Mac OS X/i.test(ua)
          ? "Mac"
          : /Windows/i.test(ua)
            ? "Windows"
            : /Linux/i.test(ua)
              ? "Linux"
              : "Selain";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Safari\//.test(ua) && !/Chrome\//.test(ua)
        ? "Safari"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : "";
  const label = browser ? `${device} · ${browser}` : device;
  return label.slice(0, 80);
}

/**
 * Logout navigates to the login screen only after the server accepted it.
 * A failed call leaves the user where they are: the cookie may still be valid.
 */
export function logoutOutcome(succeeded: boolean): "login" | "stay" {
  return succeeded ? "login" : "stay";
}

export type LockView = "open" | "locked" | "covered";

/** Local glance lock. It does not touch the server session. */
export function nextLockView(enabled: boolean, event: "hide" | "show" | "unlock"): LockView {
  if (!enabled) return "open";
  if (event === "hide") return "covered";
  if (event === "show") return "locked";
  return "open";
}

export function acceptableAppPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}
