/**
 * After `cap sync`, register lashkirja:// so a later IPA can open /bank/callback.
 * No-op when the native project is not generated yet.
 */
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { ensureIosUrlScheme } from "../src/lib/ios-url-scheme";

async function main() {
  const plistPath = path.join(process.cwd(), "ios/App/App/Info.plist");
  let raw: string;
  try {
    raw = await readFile(plistPath, "utf8");
  } catch {
    console.log("No ios/App/App/Info.plist yet. cap sync creates it; the next IPA build patches the scheme.");
    return;
  }
  const next = ensureIosUrlScheme(raw);
  if (next === raw) {
    console.log("Info.plist already has the lashkirja scheme.");
    return;
  }
  await writeFile(plistPath, next);
  console.log("Added lashkirja URL scheme to Info.plist.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
