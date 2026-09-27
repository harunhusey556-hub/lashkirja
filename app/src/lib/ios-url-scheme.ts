/** Custom scheme the next IPA registers so a closed app can open a bank callback. */

export const IOS_URL_SCHEME_BLOCK = `\t<key>CFBundleURLTypes</key>
\t<array>
\t\t<dict>
\t\t\t<key>CFBundleURLName</key>
\t\t\t<string>fi.tiyouba.lashkirja</string>
\t\t\t<key>CFBundleURLSchemes</key>
\t\t\t<array>
\t\t\t\t<string>lashkirja</string>
\t\t\t</array>
\t\t</dict>
\t</array>
`;

/** Inserts the lashkirja scheme before the closing dict of Info.plist. Idempotent. */
export function ensureIosUrlScheme(plist: string): string {
  if (plist.includes("<string>lashkirja</string>")) return plist;
  const marker = "</dict>";
  const index = plist.lastIndexOf(marker);
  if (index < 0) throw new Error("Info.plist has no dict");
  return `${plist.slice(0, index)}${IOS_URL_SCHEME_BLOCK}${plist.slice(index)}`;
}
