/**
 * Builds the Capacitor static export: `npm run build:mobile -- --api-base-url <url>`.
 *
 * Runs `next build` with `BUILD_TARGET=mobile` (selects next.config.ts's
 * mobile branch: `output: "export"`, its own `distDir: ".next-mobile"`).
 * Per export/utils.js's `hasCustomExportOutput`, that custom distDir is
 * where the exported site actually lands -- Next forces its own
 * intermediates back onto the literal `.next` regardless (shared with the
 * dev server, but safe: `next build`'s clean step preserves `.next/dev`).
 * This script then moves `.next-mobile/` to `out/`, which is the interface
 * the IPA build (Task 12) and CI depend on, and asserts the result is a
 * real, complete export before declaring success.
 *
 * Never runs a web `next build` here, never touches `.next` beyond what
 * `next build` itself does (see parallel-rules.md rule 5).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const APP_ROOT = path.resolve(__dirname, "..");
const MOBILE_DIST_DIR = path.join(APP_ROOT, ".next-mobile");
const OUT_DIR = path.join(APP_ROOT, "out");

function parseApiBaseUrl(argv: string[]): string {
  const flagIndex = argv.indexOf("--api-base-url");
  const value = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  if (!value) {
    console.error("Usage: build-mobile.ts --api-base-url <url>");
    process.exit(1);
  }
  return value;
}

/** Mirrors next.config.ts's validatedMobileApiBaseUrl(): https://, or
 * http:// on 127.0.0.1/localhost for local emulation. Checked here too so a
 * bad URL fails fast with a clear message before spawning `next build` at
 * all (next.config.ts still throws on its own if this script is bypassed). */
function validateApiBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.error(`Not a valid URL: ${raw}`);
    process.exit(1);
  }
  const isLocalHttp =
    parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  if (parsed.protocol !== "https:" && !isLocalHttp) {
    console.error(`--api-base-url must be https://, or http:// on 127.0.0.1/localhost for local emulation: ${raw}`);
    process.exit(1);
  }
  return raw.replace(/\/+$/, "");
}

function removeIfExists(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function runNextBuild(apiBaseUrl: string): void {
  const nextBin = require.resolve("next/dist/bin/next");
  execFileSync(process.execPath, [nextBin, "build"], {
    cwd: APP_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      BUILD_TARGET: "mobile",
      NEXT_PUBLIC_BUILD_TARGET: "mobile",
      NEXT_PUBLIC_API_BASE_URL: apiBaseUrl,
    },
  });
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function totalSize(dir: string): number {
  return walkFiles(dir).reduce((sum, file) => sum + statSync(file).size, 0);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function assertExists(relativePath: string): void {
  const full = path.join(OUT_DIR, relativePath);
  if (!existsSync(full)) {
    throw new Error(`Mobile export is missing ${path.join("out", relativePath)}`);
  }
}

function assertNoRouteFiles(): void {
  const offenders = walkFiles(OUT_DIR)
    .map((file) => path.relative(OUT_DIR, file))
    .filter((relativePath) => /^route(\.|$)/i.test(path.basename(relativePath)));
  if (offenders.length > 0) {
    throw new Error(`Mobile export contains route handler output: ${offenders.join(", ")}`);
  }
}

function assertNoApiDir(): void {
  if (existsSync(path.join(OUT_DIR, "api"))) {
    throw new Error("Mobile export contains an out/api/ directory -- pageExtensions did not drop route.ts");
  }
}

function assertApiBaseUrlEmbedded(apiBaseUrl: string): void {
  const staticDir = path.join(OUT_DIR, "_next", "static");
  if (!existsSync(staticDir)) {
    throw new Error("Mobile export is missing out/_next/static/");
  }
  const jsFiles = walkFiles(staticDir).filter((file) => file.endsWith(".js"));
  const found = jsFiles.some((file) => readFileSync(file, "utf8").includes(apiBaseUrl));
  if (!found) {
    throw new Error(
      `NEXT_PUBLIC_API_BASE_URL (${apiBaseUrl}) does not appear in any out/_next/static/**/*.js file`
    );
  }
}

function main(): void {
  const apiBaseUrl = validateApiBaseUrl(parseApiBaseUrl(process.argv.slice(2)));

  removeIfExists(MOBILE_DIST_DIR);
  removeIfExists(OUT_DIR);

  runNextBuild(apiBaseUrl);

  if (!existsSync(MOBILE_DIST_DIR)) {
    throw new Error(`next build did not produce ${MOBILE_DIST_DIR}`);
  }
  renameSync(MOBILE_DIST_DIR, OUT_DIR);

  assertExists("index.html");
  assertExists("login.html");
  assertExists("dashboard.html");
  assertExists(path.join("laskut", "lasku.html"));
  assertExists(path.join("_next", "static"));
  assertNoRouteFiles();
  assertNoApiDir();
  assertApiBaseUrlEmbedded(apiBaseUrl);

  console.log(`Mobile export OK: out/ is ${formatBytes(totalSize(OUT_DIR))} (api base url: ${apiBaseUrl})`);
}

main();
