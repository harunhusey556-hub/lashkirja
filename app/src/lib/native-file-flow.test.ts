import { describe, expect, it } from "vitest";
import {
  CAMERA_DENIED_MESSAGE,
  externalLinkKind,
  filePickDecision,
  isPermissionDenied,
} from "./native-file-flow";

describe("native file and permission flows", () => {
  it("uploads when the picker returns a file", () => {
    expect(filePickDecision(1, "granted")).toEqual({ kind: "upload" });
  });

  it("ignores a cancelled picker and does not upload", () => {
    expect(filePickDecision(0, "unknown")).toEqual({ kind: "ignore" });
    expect(filePickDecision(0, "granted")).toEqual({ kind: "ignore" });
  });

  it("explains a denied camera or file permission in Finnish", () => {
    expect(filePickDecision(0, "denied")).toEqual({
      kind: "denied",
      message: CAMERA_DENIED_MESSAGE,
    });
    expect(isPermissionDenied(new Error("Camera permission denied"))).toBe(true);
    expect(isPermissionDenied(new Error("The user cancelled"))).toBe(false);
  });

  it("treats an in-app path as staying in the app and https as leaving", () => {
    expect(externalLinkKind("/asetukset")).toBe("in-app");
    expect(externalLinkKind("/bank/callback?state=1")).toBe("in-app");
    expect(externalLinkKind("https://bank.example/auth")).toBe("leaves-app");
    expect(externalLinkKind("//evil.test")).toBe("leaves-app");
  });
});
