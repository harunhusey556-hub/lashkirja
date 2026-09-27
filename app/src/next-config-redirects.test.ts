import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { matchNav } from "./lib/navigation";

describe("next.config redirects", () => {
  it("points every redirect destination at a real registry entry", async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects.length).toBeGreaterThan(0);
    for (const redirect of redirects) {
      const destination = redirect.destination.replace(/:[^/]+/g, "1");
      expect(matchNav(destination), `redirect ${redirect.source} -> ${redirect.destination}`).not.toBeNull();
    }
  });
});
