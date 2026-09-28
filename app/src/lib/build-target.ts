/**
 * Which target the current bundle was built for. `next.config.ts`'s mobile
 * branch adds `NEXT_PUBLIC_BUILD_TARGET` to its `env` block, so this constant
 * folds to a literal `true`/`false` wherever Next.js inlines
 * `process.env.NEXT_PUBLIC_*` -- server code, the RSC payload, and every
 * client bundle alike. The web build never sets it, so it is `false` there
 * (including plain `next dev`).
 */
export const IS_MOBILE_BUILD: boolean = process.env.NEXT_PUBLIC_BUILD_TARGET === "mobile";

/**
 * The server origin the mobile app calls, with no trailing slash. Empty
 * string on the web build, where every request stays same-origin (relative
 * paths go through the proxy as they always have).
 *
 * `next.config.ts` throws at config load if this is missing or malformed
 * when `BUILD_TARGET=mobile`, so by the time client code runs in a mobile
 * build this is always a validated absolute origin.
 */
export const API_BASE_URL: string = IS_MOBILE_BUILD
  ? (process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/+$/, "")
  : "";

/**
 * Rewrites an absolute-path request to point at API_BASE_URL:
 * "/api/x" -> API_BASE_URL + "/api/x". Anything that is not an
 * absolute path (already a full URL, or a relative path with no leading
 * slash) is returned unchanged. On the web build API_BASE_URL is "", so
 * this is a no-op there -- every caller can use apiUrl() unconditionally on
 * both targets.
 */
export function apiUrl(path: string): string {
  if (!path.startsWith("/")) return path;
  return `${API_BASE_URL}${path}`;
}
