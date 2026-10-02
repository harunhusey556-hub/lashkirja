/**
 * Bank logos through our own server. Enable Banking hosts them on
 * enablebanking.com, which the app's CSP (img-src 'self' data: blob:) does
 * not allow, so every bank showed its initial. The client fetches the bytes
 * from /api/bank/logo and shows them as a blob: URL instead.
 */

const LOGO_HOST = "enablebanking.com";
const MAX_BYTES = 256 * 1024;
const CACHE_LIMIT = 200;

/** A 96 px wide rendition: about 2 KB instead of the 30 KB original. */
const RESIZE_SUFFIX = "-/resize/96x/";

export type LogoImage = { bytes: Uint8Array; contentType: string };

const cache = new Map<string, Promise<LogoImage | null>>();

/** Only Enable Banking's own brand images; anything else is refused. */
export function logoSourceUrl(src: string): string | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== LOGO_HOST || url.username || url.password || url.port) return null;
  if (!url.pathname.startsWith("/brands/")) return null;
  url.search = "";
  url.hash = "";
  if (!url.pathname.includes("/-/")) url.pathname = url.pathname.replace(/\/?$/, "/") + RESIZE_SUFFIX;
  return url.toString();
}

async function download(url: string): Promise<LogoImage | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "follow" });
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
  // No SVG: an image/svg+xml response could carry script into a blob: URL.
  if (!/^image\/(png|jpeg|webp|gif)$/.test(contentType)) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;
  return { bytes, contentType };
}

export function fetchBankLogo(src: string): Promise<LogoImage | null> {
  const url = logoSourceUrl(src);
  if (!url) return Promise.resolve(null);
  const hit = cache.get(url);
  if (hit) return hit;
  const pending = download(url).catch(() => null);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(url, pending);
  // A failure is not remembered, so a later request tries again.
  void pending.then((image) => {
    if (!image) cache.delete(url);
  });
  return pending;
}

export function resetBankLogoCacheForTests() {
  cache.clear();
}
