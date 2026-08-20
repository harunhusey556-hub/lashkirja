import type { NextConfig } from "next";
import os from "node:os";
import path from "node:path";

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

const nextConfig: NextConfig = {
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
};

export default nextConfig;
