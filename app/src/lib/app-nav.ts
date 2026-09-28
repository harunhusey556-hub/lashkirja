/**
 * Navigation for code that lives outside the React tree (clientFetch.ts,
 * auth-client.ts) and therefore has no `useRouter()` of its own.
 *
 * Mobile: routes through the App Router's client-side navigation (the
 * router NavBridge.tsx publishes here on mount), so a 401 mid-session or a
 * sign-out never triggers a document reload -- inside a WebView with no
 * network, that is indistinguishable from the app crashing.
 *
 * Web: today's behaviour, unchanged -- `location.assign`/`location.replace`.
 */
import { IS_MOBILE_BUILD } from "@/lib/build-target";

export interface AppRouterLike {
  push(href: string): void;
  replace(href: string): void;
}

let router: AppRouterLike | null = null;

/** Set by NavBridge.tsx once mounted, and cleared on unmount. Never called
 * on the web build. */
export function setAppRouter(next: AppRouterLike | null): void {
  router = next;
}

export function appNavigate(path: string, options: { replace?: boolean } = {}): void {
  if (IS_MOBILE_BUILD && router) {
    if (options.replace) router.replace(path);
    else router.push(path);
    return;
  }
  if (options.replace) window.location.replace(path);
  else window.location.assign(path);
}
