/**
 * Bakes the real server URL into the synced copy of offline.html, so its
 * self-healing retry script knows where to send the WebView back to once
 * the server answers again. public/offline.html ships with an empty
 * `<meta name="lashkirja-server" content="">` tag; this only ever rewrites
 * the content of that one attribute.
 */

const META_MARKER = '<meta name="lashkirja-server" content="';

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Idempotent: safe to run again (e.g. a different CAPACITOR_SERVER_URL on a later build) — it always replaces whatever is currently there. */
export function injectOfflineServerMeta(html: string, serverUrl: string): string {
  const markerIndex = html.indexOf(META_MARKER);
  if (markerIndex < 0) {
    throw new Error('offline.html has no <meta name="lashkirja-server"> tag to patch');
  }
  const contentStart = markerIndex + META_MARKER.length;
  const contentEnd = html.indexOf('"', contentStart);
  if (contentEnd < 0) {
    throw new Error("offline.html's lashkirja-server meta tag is malformed (no closing quote)");
  }
  return html.slice(0, contentStart) + escapeHtmlAttribute(serverUrl) + html.slice(contentEnd);
}
