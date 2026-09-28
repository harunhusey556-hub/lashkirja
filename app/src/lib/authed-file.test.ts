import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/components/clientFetch";
import {
  fetchAuthedFile,
  fileNameFromDisposition,
  openAuthedFile,
  shareAuthedFile,
} from "./authed-file";

function bytesResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fileNameFromDisposition", () => {
  it("reads a plain quoted filename", () => {
    expect(fileNameFromDisposition('attachment; filename="lasku-5.pdf"', "fallback.pdf")).toBe(
      "lasku-5.pdf"
    );
  });

  it("prefers the RFC 6266 extended form and decodes percent-encoding", () => {
    expect(
      fileNameFromDisposition(
        "attachment; filename=\"kuitti.pdf\"; filename*=UTF-8''kuitti%20123.pdf",
        "fallback.pdf"
      )
    ).toBe("kuitti 123.pdf");
  });

  it("falls back to the plain fallback name when the header is missing", () => {
    expect(fileNameFromDisposition(null, "fallback.pdf")).toBe("fallback.pdf");
  });

  it("falls back when the header carries no filename at all", () => {
    expect(fileNameFromDisposition("attachment", "fallback.pdf")).toBe("fallback.pdf");
  });
});

describe("fetchAuthedFile", () => {
  it("builds a File named from Content-Disposition, with the response's bytes and type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        bytesResponse(200, "%PDF-1.4 test", {
          "Content-Disposition": 'attachment; filename="lasku-9.pdf"',
          "Content-Type": "application/pdf",
        })
      )
    );

    const file = await fetchAuthedFile("/api/invoices/1/pdf", "fallback.pdf");
    expect(file.name).toBe("lasku-9.pdf");
    expect(file.type).toBe("application/pdf");
    expect(await file.text()).toBe("%PDF-1.4 test");
  });

  it("falls back to the given name when the header is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bytesResponse(200, "data")));
    const file = await fetchAuthedFile("/api/x", "fallback.csv");
    expect(file.name).toBe("fallback.csv");
  });

  it("throws the Finnish no-connection message when the network call itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    await expect(fetchAuthedFile("/api/x", "fallback")).rejects.toThrow(
      "Tiedosto ei ole saatavilla ilman yhteyttä."
    );
  });

  it("throws the Finnish no-connection message on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bytesResponse(500, "")));
    await expect(fetchAuthedFile("/api/x", "fallback")).rejects.toThrow(
      "Tiedosto ei ole saatavilla ilman yhteyttä."
    );
  });

  it("surfaces a 401 as the shared ApiError so isUnauthorized() keeps working", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bytesResponse(401, "")));
    await expect(fetchAuthedFile("/api/x", "fallback")).rejects.toMatchObject({
      status: 401,
    });
    await expect(fetchAuthedFile("/api/x", "fallback")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("shareAuthedFile (the mobile branch, exercised directly with an injected ShareRuntime)", () => {
  it("fetches the bytes and hands them to the native share sheet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        bytesResponse(200, "receipt bytes", {
          "Content-Disposition": 'attachment; filename="kuitti-1.jpg"',
          "Content-Type": "image/jpeg",
        })
      )
    );

    const calls: unknown[] = [];
    const result = await shareAuthedFile("/api/receipts/1/file", "kuitti.jpg", "Kuitti", {
      isNativePlatform: () => true,
      fileUri: async () => "file:///cache/kuitti-1.jpg",
      share: async (options) => {
        calls.push(options);
      },
    });

    expect(result).toBe("shared");
    expect(calls).toEqual([
      {
        title: "Kuitti",
        text: undefined,
        files: ["file:///cache/kuitti-1.jpg"],
        dialogTitle: "Kuitti",
      },
    ]);
  });

  it("propagates the offline message instead of ever reaching the share runtime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const share = vi.fn();
    await expect(
      shareAuthedFile("/api/receipts/1/file", "kuitti.jpg", "Kuitti", {
        isNativePlatform: () => true,
        share,
      })
    ).rejects.toThrow("Tiedosto ei ole saatavilla ilman yhteyttä.");
    expect(share).not.toHaveBeenCalled();
  });
});

describe("openAuthedFile (web branch: IS_MOBILE_BUILD is false in this test process)", () => {
  it("opens the path directly, cookie-authenticated, exactly like today", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });

    const result = await openAuthedFile("/api/invoices/1/pdf", "lasku.pdf", "Lasku 1");

    expect(open).toHaveBeenCalledWith("/api/invoices/1/pdf", "_blank", "noopener,noreferrer");
    expect(result).toBe("shared");
  });
});
