/**
 * Maps a request pathname to the file to serve from a static export root
 * (Next.js `output: "export"`, `trailingSlash: false`). Shared by
 * `scripts/mobile/serve-export.ts` (emulation on 127.0.0.1:3210) and, per the
 * plan, ported to Swift for the native Capacitor router (Task 12) -- keep
 * the two in lockstep if this changes.
 *
 * Rules, in order:
 *  - a pathname whose last segment has an extension is served as is
 *    ("/favicon.ico" -> "/favicon.ico");
 *  - "/" or "" -> "/index.html";
 *  - otherwise, try "<path>.html", then "<path>/index.html", then fall back
 *    to the SPA shell "/index.html" (the client router takes over from
 *    there; every real route already has one of the first two files, so
 *    this only fires for an unknown path).
 *
 * `exists` is asked about paths relative to the export root, with no
 * leading slash (e.g. "laskut/lasku.html") -- that is what "relativePath"
 * means here. The return value always has a leading slash, mirroring
 * `pathname`.
 */
export function resolveExportPath(pathname: string, exists: (relativePath: string) => boolean): string {
  if (hasExtension(pathname)) return pathname;
  if (pathname === "/" || pathname === "") return "/index.html";

  const trimmed = stripSlashes(pathname);
  const flat = `${trimmed}.html`;
  if (exists(flat)) return `/${flat}`;

  const nested = `${trimmed}/index.html`;
  if (exists(nested)) return `/${nested}`;

  return "/index.html";
}

function hasExtension(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return lastSegment.includes(".");
}

/** Removes exactly one leading and one trailing slash, if present. */
function stripSlashes(pathname: string): string {
  const withoutLeading = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  return withoutLeading.endsWith("/") ? withoutLeading.slice(0, -1) : withoutLeading;
}
