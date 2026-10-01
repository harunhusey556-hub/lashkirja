/** Finnish copy for passkey outcomes. Pure, so it is unit-tested on its own. */

export type PasskeyFailure =
  | "cancelled"
  | "unsupported"
  | "not-configured"
  | "exists"
  | "busy"
  | "network"
  | "rate"
  | "closed"
  | "rejected"
  | "password"
  | "failed";

/**
 * Maps a ceremony error to a reason: a native plugin code
 * (ios/App/App/PasskeyPlugin.swift), a @simplewebauthn/browser WebAuthnError
 * code, or a DOMException name.
 */
export function classifyCeremonyError(error: unknown): PasskeyFailure {
  const record = (error ?? {}) as { code?: unknown; name?: unknown };
  const code = typeof record.code === "string" ? record.code : "";
  const name = typeof record.name === "string" ? record.name : "";
  if (code === "CANCELLED" || code === "ERROR_CEREMONY_ABORTED" || name === "NotAllowedError" || name === "AbortError") {
    return "cancelled";
  }
  if (code === "EXISTS" || code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError") {
    return "exists";
  }
  if (code === "NOT_ASSOCIATED" || code === "ERROR_INVALID_RP_ID" || code === "ERROR_INVALID_DOMAIN" || name === "SecurityError") {
    return "not-configured";
  }
  if (code === "UNSUPPORTED" || code === "UNIMPLEMENTED" || name === "NotSupportedError") return "unsupported";
  if (code === "BUSY") return "busy";
  return "failed";
}

/**
 * The message to show, or null when nothing should be shown (the person
 * cancelled the system sheet themselves: no error, the screen just stays).
 * A server message wins where it was written for the user (rate, closed).
 */
export function passkeyFailureMessage(
  reason: PasskeyFailure,
  context: "sign-in" | "create",
  serverMessage?: string
): string | null {
  switch (reason) {
    case "cancelled":
      return null;
    case "unsupported":
      return "Tämä laite ei tue pääsyavaimia. Kirjaudu salasanalla.";
    case "not-configured":
      return "Pääsyavaimet eivät ole vielä käytössä tällä palvelimella. Kirjaudu salasanalla.";
    case "exists":
      return "Tällä laitteella on jo pääsyavain tälle tilille.";
    case "busy":
      return "Pääsyavainikkuna on jo auki.";
    case "network":
      return "Ei yhteyttä palvelimeen. Tarkista verkkoyhteys.";
    case "rate":
      return serverMessage ?? "Liian monta kirjautumisyritystä. Yritä myöhemmin uudelleen.";
    case "closed":
      return serverMessage ?? "Tili on suljettu.";
    case "rejected":
      return "Pääsyavain ei kelpaa. Kirjaudu salasanalla.";
    case "password":
      return serverMessage ?? "Nykyinen salasana on väärä.";
    case "failed":
    default:
      return context === "sign-in"
        ? "Kirjautuminen pääsyavaimella epäonnistui. Yritä uudelleen tai kirjaudu salasanalla."
        : "Pääsyavaimen luonti epäonnistui. Yritä uudelleen.";
  }
}

/**
 * Appended to the success copy of a password reset/change or a bulk sign-out:
 * those delete every passkey (account-security revokeAccess), and the user
 * has to know why Face ID sign-in stopped working.
 */
export function passkeysRemovedNote(count: number | undefined): string {
  if (!count || count < 1) return "";
  const lead = count === 1 ? "Pääsyavain poistettiin." : `${count} pääsyavainta poistettiin.`;
  return `${lead} Luo uusi kohdassa Asetukset > Pääsyavaimet.`;
}
