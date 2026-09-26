"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import {
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";

const NAV_ITEMS = [
  {
    href: "/dashboard",
    label: "Etusivu",
    icon: (active: boolean) => (
      <svg
        className="tab-icon h-6 w-6"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={active ? 2 : 1.75}
          d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z"
        />
      </svg>
    ),
  },
  {
    href: "/kuitit",
    label: "Kuitit",
    icon: (active: boolean) => (
      <svg
        className="tab-icon h-6 w-6"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={active ? 2 : 1.75}
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2Z"
        />
      </svg>
    ),
  },
  {
    href: "/tiliotteet",
    label: "Tiliote",
    icon: (active: boolean) => (
      <svg
        className="tab-icon h-6 w-6"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={active ? 2 : 1.75}
          d="M3 6h18M3 12h18M3 18h10"
        />
      </svg>
    ),
  },
  {
    href: "/alv-raportti",
    label: "ALV",
    icon: (active: boolean) => (
      <svg
        className="tab-icon h-6 w-6"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={active ? 2 : 1.75}
          d="M4 19V5m4 14V9m4 10V7m4 12v-4m4 4V11"
        />
      </svg>
    ),
  },
  {
    href: "/asetukset",
    label: "Asetukset",
    icon: (active: boolean) => (
      <svg
        className="tab-icon h-6 w-6"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={active ? 2 : 1.75}
          d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={active ? 2 : 1.75}
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
        />
      </svg>
    ),
  },
] as const;

function navActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function pageTitle(pathname: string): string {
  if (pathname.startsWith("/kuitit")) return "Kuitit & laskut";
  if (/^\/tiliotteet\/[^/]+$/.test(pathname)) return "Tiliote";
  if (pathname.startsWith("/tiliotteet")) return "Tiliotteet";
  if (pathname.startsWith("/alv-raportti")) return "ALV-raportti";
  if (pathname.startsWith("/asetukset")) return "Asetukset";
  return "Etusivu";
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [authAttempt, setAuthAttempt] = useState(0);
  const [authState, setAuthState] = useState<
    { status: "checking" | "ready" | "error"; message?: string }
  >({ status: "checking" });
  const pathname = usePathname();
  const title = pageTitle(pathname);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/auth/me", {
      credentials: "include",
      signal: controller.signal,
    })
      .then((response) =>
        readJson<{ user: { userId: string } }>(
          response,
          "Istunnon tarkistus epäonnistui"
        )
      )
      .then(() => setAuthState({ status: "ready" }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setAuthState({
          status: "error",
          message: errorMessage(error, "Istunnon tarkistus epäonnistui"),
        });
      });

    return () => controller.abort();
  }, [authAttempt]);

  function retryAuth() {
    setAuthState({ status: "checking" });
    setAuthAttempt((attempt) => attempt + 1);
  }

  return (
    <div className="min-h-dvh flex flex-col bg-cream">
      <header className="app-header sticky top-0 z-40 border-b border-warm-gray-light/40 bg-white/95 backdrop-blur-md">
        <div className="mx-auto flex h-[var(--app-header-bar)] max-w-lg items-center justify-center px-5">
          <h1
            ref={titleRef}
            tabIndex={-1}
            className="truncate text-[17px] font-semibold tracking-tight text-charcoal outline-none"
          >
            {title}
          </h1>
        </div>
      </header>

      <main className="app-main mx-auto w-full max-w-lg flex-1 pt-5">
        <div key={pathname} className="page-enter">
          {authState.status === "checking" ? (
            <LoadingState label="Tarkistetaan istuntoa..." />
          ) : authState.status === "error" ? (
            <ErrorState
              message={authState.message || "Istunnon tarkistus epäonnistui"}
              onRetry={retryAuth}
            />
          ) : (
            children
          )}
        </div>
      </main>

      <nav
        className="app-tab-bar fixed inset-x-0 bottom-0 z-50 border-t border-warm-gray-light/50 bg-white/95 shadow-[0_-8px_24px_rgba(45,45,45,0.04)] backdrop-blur-md"
        aria-label="Päävalikko"
      >
        <div className="mx-auto flex h-[var(--app-tab-height)] max-w-lg items-stretch px-1">
          {NAV_ITEMS.map((item) => {
            const active = navActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`tab-link flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 ${
                  active ? "text-accent-dark" : "text-warm-gray"
                }`}
                aria-current={active ? "page" : undefined}
              >
                <span className="tab-icon-plate">{item.icon(active)}</span>
                <span
                  className={`app-tab-label ${active ? "font-semibold" : "font-medium"}`}
                >
                  {item.label}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
