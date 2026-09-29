import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ApiGatewayError,
  ApiTimeoutError,
  ERROR_COPY,
  errorMessage,
  isUserFacingMessage,
} from "./clientFetch";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("errorMessage", () => {
  it("maps WebKit, Chrome and Firefox network failures to Finnish copy", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const raw of ["Load failed", "Failed to fetch", "NetworkError when attempting to fetch resource."]) {
      expect(errorMessage(new TypeError(raw), "x")).toBe(ERROR_COPY.unreachable);
      expect(errorMessage(new Error(raw), "x")).toBe(ERROR_COPY.unreachable);
    }
  });

  it("says offline when the device has no network", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("navigator", { onLine: false });
    expect(errorMessage(new TypeError("Load failed"), "x")).toBe(ERROR_COPY.offline);
  });

  it("never shows a raw server string (AUTH-09)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(errorMessage(new ApiError("PrismaClientInitializationError: can't reach", 500), "Tallennus epäonnistui")).toBe(
      ERROR_COPY.server
    );
    expect(errorMessage(new ApiError("Internal error: P2002", 500), "x")).toBe(ERROR_COPY.server);
    expect(errorMessage(new ApiError("Internal", 500), "x")).toBe(ERROR_COPY.server);
    expect(errorMessage(new ApiError("fail", 400), "Tallennus epäonnistui")).toBe("Tallennus epäonnistui");
    expect(errorMessage(new ApiError("Required", 400), "Tarkista tiedot")).toBe("Tarkista tiedot");
    expect(errorMessage(new ApiError("VALIDATION_FAILED", 400), "Tarkista tiedot")).toBe("Tarkista tiedot");
  });

  it("keeps the server's own Finnish message and its Finnish details", () => {
    expect(errorMessage(new ApiError("Sähköposti on jo käytössä", 409), "x")).toBe("Sähköposti on jo käytössä");
    expect(
      errorMessage(new ApiError("Tarkista tiedot", 400, [{ message: "IBAN on virheellinen" }, { message: "Required" }]), "x")
    ).toBe("Tarkista tiedot: IBAN on virheellinen");
  });

  it("maps status codes when the message is not for the user", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(errorMessage(new ApiError("Unauthorized", 401), "x")).toBe(ERROR_COPY.expired);
    expect(errorMessage(new ApiError("Forbidden", 403), "x")).toBe(ERROR_COPY.forbidden);
    expect(errorMessage(new ApiError("Not found", 404), "x")).toBe(ERROR_COPY.notFound);
    expect(errorMessage(new ApiError("Too many requests", 429), "x")).toBe(ERROR_COPY.rateLimited);
  });

  it("keeps the timeout and gateway copy, which carry no status code", () => {
    expect(errorMessage(new ApiTimeoutError(), "x")).toMatch(/aikakatkaistiin/);
    const gateway = errorMessage(new ApiGatewayError(502), "x");
    expect(gateway).not.toMatch(/502/);
    expect(gateway).toMatch(/Palvelin ei vastannut/);
  });

  it("logs the raw failure to the console instead of the screen", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorMessage(new ApiError("Internal error: P2002", 500), "x");
    expect(warn).toHaveBeenCalled();
  });

  it("falls back for anything that is not an Error", () => {
    expect(errorMessage("boom", "Toiminto epäonnistui")).toBe("Toiminto epäonnistui");
    expect(errorMessage(undefined, "Toiminto epäonnistui")).toBe("Toiminto epäonnistui");
  });
});

describe("isUserFacingMessage", () => {
  it("accepts ordinary Finnish, including words that contain English fragments", () => {
    for (const text of ["Tili on lukittu", "Noin 5 minuuttia", "Tarkista tiedot ja yritä uudelleen.", "Ääniviesti puuttuu"]) {
      expect(isUserFacingMessage(text)).toBe(true);
    }
  });

  it("rejects exception names, codes, English and URLs", () => {
    for (const text of [
      "",
      "Load failed",
      "TypeError: x is undefined",
      "Error: P2002",
      "Invalid input",
      "connect ECONNREFUSED 127.0.0.1:3200",
      "See https://example.test",
      "NOT_FOUND",
    ]) {
      expect(isUserFacingMessage(text)).toBe(false);
    }
  });
});

describe("isNetworkFailure", () => {
  it("counts only the engines' real network messages", async () => {
    const { isNetworkFailure } = await import("./clientFetch");
    for (const raw of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "Load failed (api.example.com)",
      "The network connection was lost.",
      "The Internet connection appears to be offline.",
      "Could not connect to the server.",
      "A server with the specified hostname could not be found.",
      "The request timed out.",
      "Network request failed",
    ]) {
      expect(isNetworkFailure(new TypeError(raw)), raw).toBe(true);
    }
  });

  it("does not hide a client bug behind the connection message", async () => {
    const { isNetworkFailure } = await import("./clientFetch");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bug = new TypeError("Cannot read properties of undefined (reading 'id')");
    expect(isNetworkFailure(bug)).toBe(false);
    expect(isNetworkFailure(new TypeError("undefined is not an object (evaluating 'a.b')"))).toBe(false);
    expect(errorMessage(bug, "Tallennus epäonnistui")).not.toBe(ERROR_COPY.unreachable);
  });
});
