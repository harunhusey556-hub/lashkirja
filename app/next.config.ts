import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

function gitCommit(): string {
  const fromEnv = process.env.GIT_COMMIT?.trim();
  if (fromEnv) return fromEnv.slice(0, 12);
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

const configuredDevOrigins = (process.env.ALLOWED_DEV_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Next.js 16 intentionally blocks dev assets when the browser uses a LAN or
// Tailscale address. Include this machine's current addresses so the mobile
// development URL hydrates instead of rendering an inert server-only shell.
const localInterfaceOrigins = Object.values(os.networkInterfaces())
  .flat()
  .filter(
    (entry): entry is NonNullable<typeof entry> =>
      Boolean(entry && entry.family === "IPv4" && !entry.internal)
  )
  .map((entry) => entry.address);

const isDevelopment = process.env.NODE_ENV !== "production";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDevelopment ? " ws: http: https:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  ...(process.env.COOKIE_SECURE === "true"
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains",
        },
      ]
    : []),
];

/**
 * Global Constraints, "Single config values": NEXT_PUBLIC_API_BASE_URL must
 * be https://, or http:// on 127.0.0.1/localhost for local emulation.
 * Throwing here (config load time) means a misconfigured mobile build fails
 * loudly at `next build` instead of shipping an app that silently can't
 * reach its server.
 */
function validatedMobileApiBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!raw) {
    throw new Error("NEXT_PUBLIC_API_BASE_URL is required when BUILD_TARGET=mobile");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`NEXT_PUBLIC_API_BASE_URL is not a valid URL: ${raw}`);
  }
  const isLocalHttp =
    parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  if (parsed.protocol !== "https:" && !isLocalHttp) {
    throw new Error(
      `NEXT_PUBLIC_API_BASE_URL must be https://, or http:// on 127.0.0.1/localhost for local emulation: ${raw}`
    );
  }
  return raw.replace(/\/+$/, "");
}

/**
 * `BUILD_TARGET=mobile` (set by scripts/build-mobile.ts) produces the
 * Capacitor static export. `pageExtensions: ["tsx"]` is what drops
 * `proxy.ts` and every `route.ts` out of this build -- see
 * pageExtensions.md:43 and next/dist/build/index.js:613-614 (Global
 * Constraints, "Next.js docs first"). `distDir: ".next-mobile"` keeps this
 * build's own export destination separate from the default `out/`, per
 * export/utils.js's `hasCustomExportOutput`: with `output: "export"` and a
 * non-default `distDir`, Next treats that `distDir` value as the export
 * destination and forces its own intermediate manifests back onto the
 * literal `.next` (shared with the dev server) regardless -- that sharing
 * is safe because `next build`'s clean step only removes `.next` entries
 * that do not start with cache/dev/lock, so `.next/dev` (what the running
 * `next dev` on :3200 needs) survives. `scripts/build-mobile.ts` moves
 * `.next-mobile/` to `out/` after the build, which is the interface Task 12
 * depends on. Never add `headers()`/`redirects()` here: both are
 * unsupported for `output: "export"` (static-exports.md).
 */
// A function, not a plain object: validatedMobileApiBaseUrl() must only run
// -- and only throw -- when the mobile branch is actually selected. An eager
// object literal would call it on every `next dev`/web build too, where
// NEXT_PUBLIC_API_BASE_URL is never set.
function buildMobileNextConfig(): NextConfig {
  return {
    output: "export",
    pageExtensions: ["tsx"],
    trailingSlash: false,
    images: { unoptimized: true },
    distDir: ".next-mobile",
    env: {
      NEXT_PUBLIC_BUILD_TARGET: "mobile",
      NEXT_PUBLIC_API_BASE_URL: validatedMobileApiBaseUrl(),
    },
  };
}

const webNextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_GIT_COMMIT: gitCommit(),
    NEXT_PUBLIC_APP_ENV: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  allowedDevOrigins: Array.from(
    new Set(["127.0.0.1", ...localInterfaceOrigins, ...configuredDevOrigins])
  ),
  poweredByHeader: false,
  turbopack: {
    root: path.resolve(__dirname),
  },
  // pdfkit reads its .afm metric files from node_modules at runtime and
  // nodemailer resolves transports dynamically; bundling either one turns
  // every PDF request into a 500. Keep them external.
  serverExternalPackages: ["pdf-parse", "read-excel-file", "pdfkit", "nodemailer"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
  async redirects() {
    // 307 on purpose: phases 2 and 3 move these destinations again.
    return [
      { source: "/tiliotteet", destination: "/pankki/tapahtumat", permanent: false },
      { source: "/tiliotteet/:id", destination: "/pankki/tapahtumat/tiliote?id=:id", permanent: false },
      { source: "/pankkitilit", destination: "/kirjanpito/pankkitilit", permanent: false },
      { source: "/pankki", destination: "/kirjanpito", permanent: false },
      { source: "/pankki/tilit", destination: "/kirjanpito/pankkitilit", permanent: false },
      { source: "/alv-raportti", destination: "/kirjanpito/alv", permanent: false },
      { source: "/ostolaskut", destination: "/kirjanpito/ostolaskut", permanent: false },
      { source: "/asetukset/kirjanpito", destination: "/kirjanpito/kaudet", permanent: false },
      { source: "/asetukset/pankkiyhteys", destination: "/kirjanpito/pankkitilit", permanent: false },
      // Detail pages moved from dynamic [id] path segments to a query
      // parameter (?id=) so the mobile static export can serve them as one
      // static HTML file each. The negative lookahead excludes each
      // parent's static sibling folders and the new detail path itself.
      {
        source: "/laskut/:id((?!uusi$|lasku$)[^/]+)",
        destination: "/laskut/lasku?id=:id",
        permanent: false,
      },
      {
        source: "/kuitit/:id((?!uusi$|kuitti$)[^/]+)",
        destination: "/kuitit/kuitti?id=:id",
        permanent: false,
      },
      {
        source: "/asiakkaat/:id((?!asiakas$)[^/]+)",
        destination: "/asiakkaat/asiakas?id=:id",
        permanent: false,
      },
      {
        source: "/pankki/tapahtumat/:id((?!tiliote$)[^/]+)",
        destination: "/pankki/tapahtumat/tiliote?id=:id",
        permanent: false,
      },
    ];
  },
};

const nextConfig: NextConfig = process.env.BUILD_TARGET === "mobile" ? buildMobileNextConfig() : webNextConfig;

export default nextConfig;
