import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { rejectCrossSite, rejectOversizedContentLength, safeInternalPath } from "./http-security";

function request(headers: Record<string, string>, url = "http://127.0.0.1:3791/api/x") {
  return new NextRequest(new URL(url), { method: "POST", headers });
}

const originalAppOrigin = process.env.APP_ORIGIN;

afterEach(() => {
  if (originalAppOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = originalAppOrigin;
});

describe("rejectCrossSite", () => {
  it("blocks a browser-declared cross-site request outright", () => {
    const response = rejectCrossSite(request({ "sec-fetch-site": "cross-site" }));
    expect(response?.status).toBe(403);
  });

  it("allows requests with no Origin header (curl, same-origin GET)", () => {
    expect(rejectCrossSite(request({}))).toBeNull();
    expect(rejectCrossSite(request({ "sec-fetch-site": "same-origin" }))).toBeNull();
  });

  it("allows a same-host Origin when APP_ORIGIN is not configured", () => {
    delete process.env.APP_ORIGIN;
    const response = rejectCrossSite(
      request({
        origin: "http://127.0.0.1:3791",
        host: "127.0.0.1:3791",
        "sec-fetch-site": "same-origin",
      })
    );
    expect(response).toBeNull();
  });

  it("tolerates a TLS-terminating proxy where the scheme differs", () => {
    delete process.env.APP_ORIGIN;
    expect(
      rejectCrossSite(
        request({ origin: "https://lashkirja.fi", host: "lashkirja.fi" })
      )
    ).toBeNull();
  });

  it("blocks a foreign Origin against the real host", () => {
    delete process.env.APP_ORIGIN;
    const response = rejectCrossSite(
      request({ origin: "http://evil.test", host: "127.0.0.1:3791" })
    );
    expect(response?.status).toBe(403);
  });

  it("blocks a port mismatch on the same hostname", () => {
    delete process.env.APP_ORIGIN;
    const response = rejectCrossSite(
      request({ origin: "http://127.0.0.1:9999", host: "127.0.0.1:3791" })
    );
    expect(response?.status).toBe(403);
  });

  it("requires an exact match once APP_ORIGIN is configured", () => {
    process.env.APP_ORIGIN = "https://lashkirja.fi";
    expect(
      rejectCrossSite(request({ origin: "https://lashkirja.fi", host: "internal:3000" }))
    ).toBeNull();
    expect(
      rejectCrossSite(request({ origin: "http://lashkirja.fi", host: "internal:3000" }))?.status
    ).toBe(403);
    expect(
      rejectCrossSite(request({ origin: "https://evil.test", host: "lashkirja.fi" }))?.status
    ).toBe(403);
  });

  it("blocks a malformed Origin instead of failing open", () => {
    delete process.env.APP_ORIGIN;
    const response = rejectCrossSite(request({ origin: "not a url", host: "127.0.0.1:3791" }));
    expect(response?.status).toBe(403);
  });

  it("passes an allowed app-client Origin even with sec-fetch-site: cross-site", () => {
    const response = rejectCrossSite(
      request({ origin: "capacitor://localhost", "sec-fetch-site": "cross-site" })
    );
    expect(response).toBeNull();
  });

  it("still blocks a foreign Origin declared cross-site", () => {
    const response = rejectCrossSite(
      request({ origin: "https://evil.test", "sec-fetch-site": "cross-site" })
    );
    expect(response?.status).toBe(403);
  });
});

describe("rejectOversizedContentLength", () => {
  it("allows a missing or small body", () => {
    expect(rejectOversizedContentLength(request({}))).toBeNull();
    expect(rejectOversizedContentLength(request({ "content-length": "100" }))).toBeNull();
  });

  it("rejects an oversized body and a nonsense length", () => {
    expect(rejectOversizedContentLength(request({ "content-length": "999999999" }))?.status).toBe(413);
    expect(rejectOversizedContentLength(request({ "content-length": "-1" }))?.status).toBe(400);
    expect(rejectOversizedContentLength(request({ "content-length": "abc" }))?.status).toBe(400);
  });

  it("honours a custom maximum", () => {
    expect(rejectOversizedContentLength(request({ "content-length": "2048" }), 1024)?.status).toBe(413);
  });
});

describe("safeInternalPath", () => {
  it("accepts a plain internal path with a query string", () => {
    expect(safeInternalPath("/laskut?filter=avoin")).toBe("/laskut?filter=avoin");
  });

  it("falls back for a missing or empty value", () => {
    expect(safeInternalPath(null)).toBe("/dashboard");
    expect(safeInternalPath(undefined)).toBe("/dashboard");
    expect(safeInternalPath("")).toBe("/dashboard");
  });

  it("honours a custom fallback", () => {
    expect(safeInternalPath(null, "/login")).toBe("/login");
  });

  it("rejects protocol-relative and backslash open-redirect tricks", () => {
    expect(safeInternalPath("//evil.test")).toBe("/dashboard");
    expect(safeInternalPath("/\\evil.test")).toBe("/dashboard");
  });

  it("rejects an absolute URL or a value with no leading slash", () => {
    expect(safeInternalPath("https://evil.test")).toBe("/dashboard");
    expect(safeInternalPath("evil.test")).toBe("/dashboard");
  });

  it("rejects control characters and oversized values", () => {
    expect(safeInternalPath("/laskut\n/evil")).toBe("/dashboard");
    expect(safeInternalPath(`/${"a".repeat(3000)}`)).toBe("/dashboard");
  });
});
