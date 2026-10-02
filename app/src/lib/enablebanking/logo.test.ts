import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBankLogo, logoSourceUrl, resetBankLogoCacheForTests } from "./logo";

afterEach(() => {
  resetBankLogoCacheForTests();
  vi.unstubAllGlobals();
});

describe("bank logo proxy", () => {
  it("accepts only Enable Banking brand images, resized", () => {
    expect(logoSourceUrl("https://enablebanking.com/brands/FI/Nordea/")).toBe(
      "https://enablebanking.com/brands/FI/Nordea/-/resize/96x/"
    );
    expect(logoSourceUrl("https://enablebanking.com/brands/FI/Nordea/-/resize/500x/")).toBe(
      "https://enablebanking.com/brands/FI/Nordea/-/resize/500x/"
    );
    expect(logoSourceUrl("http://enablebanking.com/brands/FI/Nordea/")).toBeNull();
    expect(logoSourceUrl("https://evil.example/brands/FI/Nordea/")).toBeNull();
    expect(logoSourceUrl("https://enablebanking.com.evil.example/brands/x/")).toBeNull();
    expect(logoSourceUrl("https://enablebanking.com/api/secret")).toBeNull();
    expect(logoSourceUrl("not a url")).toBeNull();
  });

  it("downloads once and refuses non-raster content", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await fetchBankLogo("https://enablebanking.com/brands/FI/Nordea/");
    await fetchBankLogo("https://enablebanking.com/brands/FI/Nordea/");
    expect(first?.contentType).toBe("image/webp");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })));
    expect(await fetchBankLogo("https://enablebanking.com/brands/FI/OP/")).toBeNull();
  });
});
