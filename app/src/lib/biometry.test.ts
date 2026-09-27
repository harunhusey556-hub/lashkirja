import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkBiometry, authenticate } = vi.hoisted(() => ({
  checkBiometry: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock("@aparajita/capacitor-biometric-auth", () => ({
  BiometricAuth: {
    checkBiometry: (...args: unknown[]) => checkBiometry(...args),
    authenticate: (...args: unknown[]) => authenticate(...args),
  },
  BiometryType: {
    none: 0,
    touchId: 1,
    faceId: 2,
    fingerprintAuthentication: 3,
    faceAuthentication: 4,
    irisAuthentication: 5,
  },
  BiometryErrorType: {
    none: "",
    userCancel: "userCancel",
    biometryNotAvailable: "biometryNotAvailable",
    biometryNotEnrolled: "biometryNotEnrolled",
    noDeviceCredential: "noDeviceCredential",
    passcodeNotSet: "passcodeNotSet",
    authenticationFailed: "authenticationFailed",
  },
  BiometryError: class BiometryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

import { BiometryError, BiometryErrorType, BiometryType } from "@aparajita/capacitor-biometric-auth";
import {
  biometricEnableLabel,
  biometricUnavailableCopy,
  biometricUnlockLabel,
  classifyBiometry,
  classifyBiometryFailure,
  readDeviceBiometry,
  unlockWithBiometry,
} from "./biometry";

function check(type: number, isAvailable: boolean) {
  return {
    isAvailable,
    strongBiometryIsAvailable: isAvailable,
    biometryType: type,
    biometryTypes: isAvailable ? [type] : [],
    deviceIsSecure: false,
    reason: "",
    code: isAvailable ? BiometryErrorType.none : BiometryErrorType.biometryNotAvailable,
  };
}

describe("biometric preference helpers", () => {
  beforeEach(() => {
    checkBiometry.mockReset();
    authenticate.mockReset();
  });

  it("names Face ID and Touch ID and treats a missing sensor as unavailable", () => {
    expect(classifyBiometry(BiometryType.faceId, true)).toBe("face");
    expect(classifyBiometry(BiometryType.touchId, true)).toBe("touch");
    expect(classifyBiometry(BiometryType.faceId, false)).toBe("none");
    expect(biometricUnlockLabel("face")).toBe("Avaa Face ID:llä");
    expect(biometricEnableLabel("touch")).toBe("Ota Touch ID käyttöön");
    expect(classifyBiometryFailure(BiometryErrorType.userCancel)).toBe("cancel");
    expect(classifyBiometryFailure(BiometryErrorType.biometryNotEnrolled)).toBe("unavailable");
    expect(biometricUnavailableCopy("web")).toMatch(/selain/);
    expect(biometricUnavailableCopy("native")).toMatch(/koodilla/);
    expect(biometricUnavailableCopy("native", "missing-plugin")).toMatch(/IPA/);
  });

  it("reports unavailable when the plugin is missing and does not throw", async () => {
    checkBiometry.mockRejectedValue(new Error("plugin not implemented"));
    await expect(readDeviceBiometry()).resolves.toEqual({
      available: false,
      kind: "none",
      host: "web",
      gap: "unsupported",
    });
    await expect(unlockWithBiometry()).resolves.toBe("unavailable");
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("accepts a successful Face ID prompt and treats cancel as a PIN fallback", async () => {
    checkBiometry.mockResolvedValue(check(BiometryType.faceId, true));
    authenticate.mockResolvedValueOnce(undefined);
    await expect(readDeviceBiometry()).resolves.toMatchObject({ available: true, kind: "face" });
    await expect(unlockWithBiometry()).resolves.toBe("ok");
    expect(authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        allowDeviceCredential: false,
        iosFallbackTitle: "",
        cancelTitle: "Käytä koodia",
      })
    );

    authenticate.mockRejectedValueOnce(new BiometryError("cancelled", BiometryErrorType.userCancel));
    await expect(unlockWithBiometry()).resolves.toBe("cancel");
  });
});
