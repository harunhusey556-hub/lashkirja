/**
 * After `cap sync`, bake the real server URL into the synced copy of
 * offline.html's <meta name="lashkirja-server"> tag, so its self-healing
 * retry script knows where to send the WebView back to. No-op when the
 * native project is not generated yet, or when no server URL is set.
 */
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { injectOfflineServerMeta } from "../src/lib/ios-offline-server";

async function main() {
  const serverUrl = process.env.CAPACITOR_SERVER_URL?.trim();
  if (!serverUrl) {
    console.log("CAPACITOR_SERVER_URL is not set; offline.html's server meta tag stays empty.");
    return;
  }

  const offlinePath = path.join(process.cwd(), "ios/App/App/public/offline.html");
  let raw: string;
  try {
    raw = await readFile(offlinePath, "utf8");
  } catch {
    console.log(
      "No ios/App/App/public/offline.html yet. cap sync creates it; the next IPA build patches it."
    );
    return;
  }
  const next = injectOfflineServerMeta(raw, serverUrl);
  if (next === raw) {
    console.log("offline.html already has this server URL baked in.");
    return;
  }
  await writeFile(offlinePath, next);
  console.log(`Baked ${serverUrl} into offline.html's retry target.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
