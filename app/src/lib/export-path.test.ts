import { describe, expect, it } from "vitest";
import { resolveExportPath } from "./export-path";

function fakeExists(files: string[]): (relativePath: string) => boolean {
  const set = new Set(files);
  return (relativePath: string) => set.has(relativePath);
}

describe("resolveExportPath", () => {
  it("serves a path with an extension as is", () => {
    const exists = fakeExists([]);
    expect(resolveExportPath("/favicon.ico", exists)).toBe("/favicon.ico");
    expect(resolveExportPath("/manifest.json", exists)).toBe("/manifest.json");
    expect(resolveExportPath("/_next/static/chunks/main.js", exists)).toBe("/_next/static/chunks/main.js");
  });

  it("maps / and the empty string to /index.html", () => {
    const exists = fakeExists([]);
    expect(resolveExportPath("/", exists)).toBe("/index.html");
    expect(resolveExportPath("", exists)).toBe("/index.html");
  });

  it("prefers <path>.html over <path>/index.html when both exist", () => {
    const exists = fakeExists(["laskut/lasku.html", "laskut/lasku/index.html"]);
    expect(resolveExportPath("/laskut/lasku", exists)).toBe("/laskut/lasku.html");
    expect(resolveExportPath("/laskut/lasku/", exists)).toBe("/laskut/lasku.html");
  });

  it("falls back to <path>/index.html when the flat file does not exist", () => {
    const exists = fakeExists(["dashboard/index.html"]);
    expect(resolveExportPath("/dashboard", exists)).toBe("/dashboard/index.html");
    expect(resolveExportPath("/dashboard/", exists)).toBe("/dashboard/index.html");
  });

  it("falls back to the SPA shell when neither candidate exists", () => {
    const exists = fakeExists([]);
    expect(resolveExportPath("/does/not/exist", exists)).toBe("/index.html");
  });

  it("passes relative paths to exists() with no leading slash", () => {
    const seen: string[] = [];
    resolveExportPath("/a/b", (relativePath) => {
      seen.push(relativePath);
      return false;
    });
    expect(seen).toEqual(["a/b.html", "a/b/index.html"]);
  });

  it("handles a top-level route the same way as a nested one", () => {
    const exists = fakeExists(["login.html"]);
    expect(resolveExportPath("/login", exists)).toBe("/login.html");
    expect(resolveExportPath("/login/", exists)).toBe("/login.html");
  });
});
