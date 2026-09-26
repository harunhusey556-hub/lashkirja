import { NextRequest } from "next/server";
import { sealData } from "iron-session";
import { sessionOptions, type SessionData } from "@/lib/session";

const BASE_URL = "http://localhost:3000";

/** Parsed JSON is untyped by nature; tests narrow it at the call site. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonValue = any;

/** A genuinely sealed iron-session cookie - the routes verify it for real. */
export async function sessionCookie(user: {
  id: string;
  email: string;
}): Promise<string> {
  const sealed = await sealData(
    { userId: user.id, email: user.email, firstName: "Testi" } satisfies SessionData,
    { password: sessionOptions.password as string, ttl: sessionOptions.ttl }
  );
  return `${sessionOptions.cookieName}=${sealed}`;
}

export interface RequestOptions {
  cookie?: string;
  origin?: string;
  secFetchSite?: string;
  headers?: Record<string, string>;
}

export function buildRequest(
  method: string,
  pathAndQuery: string,
  body?: unknown,
  options: RequestOptions = {}
): NextRequest {
  const headers = new Headers(options.headers ?? {});
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin) headers.set("origin", options.origin);
  if (options.secFetchSite) headers.set("sec-fetch-site", options.secFetchSite);

  const init: { method: string; headers: Headers; body?: string } = { method, headers };
  if (body !== undefined) {
    const serialized = JSON.stringify(body);
    headers.set("content-type", "application/json");
    headers.set("content-length", String(Buffer.byteLength(serialized)));
    init.body = serialized;
  }

  return new NextRequest(new URL(pathAndQuery, BASE_URL), init);
}

/** Route params come in as a promise in the App Router. */
export function routeContext<T extends Record<string, string>>(params: T) {
  return { params: Promise.resolve(params) };
}

export async function readJson<T = JsonValue>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Response was not JSON (status ${response.status}): ${text.slice(0, 300)}`);
  }
}

/** Multipart upload request. The upload routes read req.formData() directly. */
export function buildFormRequest(
  pathAndQuery: string,
  form: FormData,
  options: RequestOptions = {}
): NextRequest {
  const headers = new Headers(options.headers ?? {});
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin) headers.set("origin", options.origin);
  if (options.secFetchSite) headers.set("sec-fetch-site", options.secFetchSite);

  return new NextRequest(new URL(pathAndQuery, BASE_URL), {
    method: "POST",
    headers,
    body: form,
  });
}
