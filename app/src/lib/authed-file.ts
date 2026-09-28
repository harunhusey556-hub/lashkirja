"use client";

/**
 * Files (PDFs, receipt images, CSV/zip exports) behind the API's
 * authenticated file endpoints.
 *
 * Web: the browser already carries the session cookie, so a plain
 * `<a href>`/`window.open` keeps working exactly as before -- these helpers
 * are a no-op there beyond passing the path through.
 *
 * Mobile: there is no cookie (Task 1/2 -- app-origin requests never send
 * one), so a bare `<a href>` or `<img src>` pointed at `/api/...` would 401.
 * Every file byte has to go through `apiFetch`, which attaches the bearer
 * token, and then either into the native share sheet (a document) or an
 * object URL (an inline image preview). Nothing fetched here is written to
 * the persistent page cache -- it is either handed straight to the share
 * sheet or kept as an in-memory object URL for exactly as long as the
 * component using it is mounted.
 */
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/components/clientFetch";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { shareContent, type ShareResult, type ShareRuntime } from "@/lib/share";

const FILE_UNAVAILABLE_MESSAGE = "Tiedosto ei ole saatavilla ilman yhteyttä.";

/**
 * Reads the file name a `Content-Disposition` response header carries.
 * Handles the extended `filename*=UTF-8''...` form (percent-encoded, wins
 * when present -- RFC 6266) and the plain quoted/bare `filename=` form.
 * Falls back when the header is missing or unparsable.
 */
export function fileNameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;

  const extended = header.match(/filename\*\s*=\s*([^;]+)/i);
  if (extended) {
    const value = extended[1].trim().replace(/^"|"$/g, "");
    const parts = value.split("''");
    if (parts.length === 2) {
      try {
        const decoded = decodeURIComponent(parts[1]);
        if (decoded) return decoded;
      } catch {
        // Malformed percent-encoding -- fall through to the plain form.
      }
    }
  }

  const quoted = header.match(/filename\s*=\s*"([^"]+)"/i);
  if (quoted && quoted[1]) return quoted[1];

  const bare = header.match(/filename\s*=\s*([^;]+)/i);
  if (bare) {
    const name = bare[1].trim().replace(/^"|"$/g, "");
    if (name) return name;
  }

  return fallback;
}

/**
 * Fetches an authenticated file's bytes (mobile: bearer token via
 * `apiFetch`; web: the session cookie, same call) and returns it as a
 * `File`, named from the response's `Content-Disposition` header.
 *
 * Throws with the Finnish "no connection" copy on a network failure or a
 * non-2xx response, except a 401, which is surfaced as the same `ApiError`
 * every other authenticated call throws, so existing `isUnauthorized()`
 * callers keep working unchanged.
 */
export async function fetchAuthedFile(path: string, fallbackName: string): Promise<File> {
  let response: Response;
  try {
    response = await apiFetch(path, { credentials: "include" });
  } catch {
    throw new Error(FILE_UNAVAILABLE_MESSAGE);
  }

  if (!response.ok) {
    if (response.status === 401) throw new ApiError("Istunto vanhentui.", 401);
    throw new Error(FILE_UNAVAILABLE_MESSAGE);
  }

  const blob = await response.blob();
  const name = fileNameFromDisposition(response.headers.get("Content-Disposition"), fallbackName);
  return new File([blob], name, { type: blob.type || "application/octet-stream" });
}

/**
 * The mobile branch of `openAuthedFile`, factored out as its own export so
 * unit tests can exercise it directly with an injected `ShareRuntime`
 * (`share.ts`'s existing seam) without needing `IS_MOBILE_BUILD` -- a
 * build-time constant baked in at module load -- to actually be true in the
 * test process (same reason `clientFetch.ts`'s `mobileApiRequest` is its
 * own export; see task-5-report.md).
 */
export async function shareAuthedFile(
  path: string,
  fallbackName: string,
  title: string,
  runtime?: Partial<ShareRuntime>
): Promise<ShareResult> {
  const file = await fetchAuthedFile(path, fallbackName);
  return shareContent({ title, file }, runtime);
}

/**
 * Opens or shares an authenticated file.
 *
 * Web: `window.open(path)` -- today's behaviour, cookie-authenticated.
 * Mobile: fetches the bytes with the bearer token and hands them to the
 * native share sheet, since a bare navigation/new tab has no cookie to
 * authenticate with and nothing to save the result to.
 */
export async function openAuthedFile(
  path: string,
  fallbackName: string,
  title: string
): Promise<ShareResult> {
  if (!IS_MOBILE_BUILD) {
    if (typeof window !== "undefined") {
      window.open(path, "_blank", "noopener,noreferrer");
    }
    return "shared";
  }
  return shareAuthedFile(path, fallbackName, title);
}

/**
 * Web: returns `path` unchanged -- an `<img src>` pointed straight at the
 * API works today because the cookie rides along.
 *
 * Mobile: fetches the bytes with the bearer token and exposes them as an
 * object URL, revoked whenever `path` changes or the component unmounts.
 * `failed` is true on a network error or non-2xx response (offline, or the
 * file genuinely does not exist) -- never left permanently in "loading".
 */
export function useAuthedObjectUrl(path: string | null): { src: string | null; failed: boolean } {
  const [state, setState] = useState<{ src: string | null; failed: boolean }>(() =>
    IS_MOBILE_BUILD ? { src: null, failed: false } : { src: path, failed: false }
  );

  useEffect(() => {
    if (!IS_MOBILE_BUILD) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- web: keep `state.src` in sync with the `path` prop, no async work at all
      setState({ src: path, failed: false });
      return;
    }
    if (!path) {
      setState({ src: null, failed: false });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ src: null, failed: false });

    void fetchAuthedFile(path, "tiedosto")
      .then((file) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(file);
        setState({ src: objectUrl, failed: false });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ src: null, failed: true });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  return state;
}
