/**
 * Face ID / Touch ID for the local glance lock.
 *
 * The native path is @aparajita/capacitor-biometric-auth (LocalAuthentication).
 * A browser, or an IPA built before the plugin, reports unavailable and the
 * PIN stays. This is not the server session.
 */
import { Capacitor } from "@capacitor/core";
import {
  BiometricAuth,
  BiometryErrorType,
  BiometryType,
  type CheckBiometryResult,
} from "@aparajita/capacitor-biometric-auth";

export type BiometryKind = "face" | "touch" | "other" | "none";
export type BiometryPromptResult = "ok" | "cancel" | "unavailable";

export type BiometryGap = "ready" | "unsupported" | "missing-plugin";

export interface BiometryStatus {
  available: boolean;
  kind: BiometryKind;
  host: "native" | "web";
  gap: BiometryGap;
}

export function biometryHost(): "native" | "web" {
  try {
    return Capacitor.isNativePlatform() ? "native" : "web";
  } catch {
    return "web";
  }
}

export function classifyBiometry(type: number, available: boolean): BiometryKind {
  if (!available) return "none";
  if (type === BiometryType.faceId || type === BiometryType.faceAuthentication) return "face";
  if (type === BiometryType.touchId || type === BiometryType.fingerprintAuthentication) return "touch";
  return "other";
}

export function classifyBiometryFailure(code: string | undefined): Exclude<BiometryPromptResult, "ok"> {
  if (
    code === BiometryErrorType.biometryNotAvailable ||
    code === BiometryErrorType.biometryNotEnrolled ||
    code === BiometryErrorType.noDeviceCredential ||
    code === BiometryErrorType.passcodeNotSet
  ) {
    return "unavailable";
  }
  return "cancel";
}

export function biometricUnlockLabel(kind: BiometryKind): string {
  if (kind === "face") return "Avaa Face ID:llä";
  if (kind === "touch") return "Avaa Touch ID:llä";
  return "Avaa biometrialla";
}

export function biometricEnableLabel(kind: BiometryKind): string {
  if (kind === "face") return "Ota Face ID käyttöön";
  if (kind === "touch") return "Ota Touch ID käyttöön";
  return "Ota biometria käyttöön";
}

export function biometricUnavailableCopy(
  host: "native" | "web",
  gap: Exclude<BiometryGap, "ready"> = "unsupported"
): string {
  if (host === "native" && gap === "missing-plugin") {
    return "Tämä asennus ei vielä kysy Face ID:tä. Uusi IPA tuo kytkimen. Siihen asti avaat lukon koodilla.";
  }
  if (host === "native") {
    return "Tällä laitteella ei ole käytössä olevaa Face ID:tä tai Touch ID:tä. Lukitus avataan koodilla.";
  }
  return "Tämä on selain. Face ID ja Touch ID kytketään asennetussa iOS-sovelluksessa. Täällä avaat lukon koodilla.";
}

export function statusFromCheck(result: CheckBiometryResult, host: "native" | "web"): BiometryStatus {
  const available = Boolean(result.isAvailable);
  return {
    available,
    kind: classifyBiometry(result.biometryType, available),
    host,
    gap: available ? "ready" : "unsupported",
  };
}

let inFlight: Promise<BiometryPromptResult> | null = null;

export async function readDeviceBiometry(): Promise<BiometryStatus> {
  const host = biometryHost();
  try {
    const result = await BiometricAuth.checkBiometry();
    return statusFromCheck(result, host);
  } catch {
    return {
      available: false,
      kind: "none",
      host,
      gap: host === "native" ? "missing-plugin" : "unsupported",
    };
  }
}

/** Presents Face ID or Touch ID. Never throws. Device passcode is not used. */
export function unlockWithBiometry(): Promise<BiometryPromptResult> {
  if (inFlight) return inFlight;
  inFlight = promptBiometry().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function promptBiometry(): Promise<BiometryPromptResult> {
  try {
    const status = await readDeviceBiometry();
    if (!status.available) return "unavailable";
    await BiometricAuth.authenticate({
      reason: "Avaa LashKirjan näytön lukitus",
      cancelTitle: "Käytä koodia",
      allowDeviceCredential: false,
      iosFallbackTitle: "",
      androidTitle: "LashKirja",
      androidSubtitle: "Näytön lukitus",
    });
    return "ok";
  } catch (error) {
    const code = (error as { code?: string }).code;
    return classifyBiometryFailure(code);
  }
}
