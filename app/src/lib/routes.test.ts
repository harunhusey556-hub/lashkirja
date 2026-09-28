import { describe, expect, it } from "vitest";
import { DETAIL_ROUTES, detailHref, normalizeLegacyDetailPath } from "./routes";

describe("detailHref", () => {
  it("builds the query-parameter path for each detail kind", () => {
    expect(detailHref("invoice", "abc")).toBe("/laskut/lasku?id=abc");
    expect(detailHref("receipt", "abc")).toBe("/kuitit/kuitti?id=abc");
    expect(detailHref("customer", "abc")).toBe("/asiakkaat/asiakas?id=abc");
    expect(detailHref("statement", "abc")).toBe("/pankki/tapahtumat/tiliote?id=abc");
  });

  it("appends extra params after id, in insertion order", () => {
    expect(detailHref("invoice", "abc", { x: "1", y: "2" })).toBe("/laskut/lasku?id=abc&x=1&y=2");
  });

  it("ignores an `id` key inside extra so the real id always wins", () => {
    expect(detailHref("invoice", "abc", { id: "hijack", x: "1" })).toBe("/laskut/lasku?id=abc&x=1");
  });

  it("every DETAIL_ROUTES entry has a matching detailHref kind", () => {
    for (const [kind, path] of Object.entries(DETAIL_ROUTES)) {
      expect(detailHref(kind as keyof typeof DETAIL_ROUTES, "1")).toBe(`${path}?id=1`);
    }
  });
});

describe("normalizeLegacyDetailPath", () => {
  it("rewrites a legacy detail path to the new query-parameter path", () => {
    expect(normalizeLegacyDetailPath("/laskut/abc")).toBe("/laskut/lasku?id=abc");
    expect(normalizeLegacyDetailPath("/kuitit/abc")).toBe("/kuitit/kuitti?id=abc");
    expect(normalizeLegacyDetailPath("/asiakkaat/abc")).toBe("/asiakkaat/asiakas?id=abc");
    expect(normalizeLegacyDetailPath("/pankki/tapahtumat/abc")).toBe(
      "/pankki/tapahtumat/tiliote?id=abc"
    );
  });

  it("keeps extra query params after id", () => {
    expect(normalizeLegacyDetailPath("/laskut/abc?x=1")).toBe("/laskut/lasku?id=abc&x=1");
  });

  it("returns null for a static sibling folder", () => {
    expect(normalizeLegacyDetailPath("/laskut/uusi")).toBeNull();
    expect(normalizeLegacyDetailPath("/kuitit/uusi")).toBeNull();
  });

  it("returns null for the new paths themselves", () => {
    expect(normalizeLegacyDetailPath("/laskut/lasku")).toBeNull();
    expect(normalizeLegacyDetailPath("/laskut/lasku?id=1")).toBeNull();
    expect(normalizeLegacyDetailPath("/kuitit/kuitti")).toBeNull();
    expect(normalizeLegacyDetailPath("/asiakkaat/asiakas")).toBeNull();
    expect(normalizeLegacyDetailPath("/pankki/tapahtumat/tiliote")).toBeNull();
  });

  it("returns null for a deeper or unrelated path", () => {
    expect(normalizeLegacyDetailPath("/laskut/abc/def")).toBeNull();
    expect(normalizeLegacyDetailPath("/laskut/")).toBeNull();
    expect(normalizeLegacyDetailPath("/laskut")).toBeNull();
    expect(normalizeLegacyDetailPath("/kirjanpito/alv")).toBeNull();
  });
});
