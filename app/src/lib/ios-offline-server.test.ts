import { describe, expect, it } from "vitest";
import { injectOfflineServerMeta } from "./ios-offline-server";

const SAMPLE = `<!DOCTYPE html>
<html lang="fi">
  <head>
    <meta name="lashkirja-server" content="" />
    <title>LashKirja ei latautunut</title>
  </head>
</html>
`;

describe("injectOfflineServerMeta", () => {
  it("fills the empty meta tag with the server URL", () => {
    const patched = injectOfflineServerMeta(SAMPLE, "https://lashkirja.example.com");
    expect(patched).toContain('<meta name="lashkirja-server" content="https://lashkirja.example.com" />');
  });

  it("is idempotent: patching an already-patched file replaces the old value, not appends", () => {
    const first = injectOfflineServerMeta(SAMPLE, "https://old.example.com");
    const second = injectOfflineServerMeta(first, "https://new.example.com");
    expect(second).toContain('content="https://new.example.com"');
    expect(second).not.toContain("old.example.com");
    expect(second.match(/lashkirja-server/g)?.length).toBe(1);
  });

  it("escapes a quote so the URL cannot break out of the attribute", () => {
    const patched = injectOfflineServerMeta(SAMPLE, 'https://example.com/"onmouseover="x');
    expect(patched).toContain('content="https://example.com/&quot;onmouseover=&quot;x"');
    expect(patched).not.toContain('content="https://example.com/"onmouseover="x"');
  });

  it("throws instead of silently doing nothing when the marker is missing", () => {
    expect(() => injectOfflineServerMeta("<html></html>", "https://example.com")).toThrow(
      /lashkirja-server/
    );
  });
});
