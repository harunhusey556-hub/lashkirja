import { describe, expect, it } from "vitest";
import { ensureIosUrlScheme } from "./ios-url-scheme";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleIdentifier</key>
\t<string>fi.tiyouba.lashkirja</string>
</dict>
</plist>
`;

describe("ensureIosUrlScheme", () => {
  it("adds the custom scheme once", () => {
    const once = ensureIosUrlScheme(SAMPLE);
    expect(once).toContain("<string>lashkirja</string>");
    expect(once).toContain("CFBundleURLTypes");
    expect(ensureIosUrlScheme(once)).toBe(once);
  });
});
