import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, convertFileSrc: (value: string) => value },
}));

import {
  CAMERA_PERMISSION_DENIED,
  classifyPickError,
  fileFromBase64,
  permissionAllowsAccess,
  captureWithCamera,
  chooseDocuments,
  choosePhotoLibrary,
} from "./native-pick";

describe("native permission picks", () => {
  it("treats full and limited photo access as usable", () => {
    expect(permissionAllowsAccess("granted")).toBe(true);
    expect(permissionAllowsAccess("limited")).toBe(true);
    expect(permissionAllowsAccess("denied")).toBe(false);
    expect(permissionAllowsAccess("prompt")).toBe(false);
  });

  it("tells cancel apart from a denied camera", () => {
    expect(classifyPickError(new Error("User cancelled photos app"))).toBe("cancel");
    expect(classifyPickError(new Error("Camera permission denied"))).toBe("denied");
    expect(classifyPickError(new Error("picker failed"))).toBe("failed");
  });

  it("builds a file from base64 without a native path", () => {
    const file = fileFromBase64(btoa("kuitti"), "kuitti.jpg", "image/jpeg");
    expect(file.name).toBe("kuitti.jpg");
    expect(file.type).toBe("image/jpeg");
    expect(file.size).toBe(6);
  });

  it("stays on the file input when the shell is a browser", async () => {
    await expect(captureWithCamera()).resolves.toEqual({ kind: "unavailable" });
    await expect(choosePhotoLibrary()).resolves.toEqual({ kind: "unavailable" });
    await expect(chooseDocuments(["application/pdf"])).resolves.toEqual({ kind: "unavailable" });
    expect(CAMERA_PERMISSION_DENIED).toMatch(/kamera/i);
  });
});
