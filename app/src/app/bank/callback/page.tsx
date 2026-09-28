"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { buttonClass } from "@/components/control-styles";
import { Card, DetailHero } from "@/components/ds";
import { appReturnUrl, classifyBankReturn, isAppBankState } from "@/lib/bank-return";
import { clearBankAuth } from "@/lib/open-bank-auth";
import { IS_MOBILE_BUILD } from "@/lib/build-target";

interface CallbackResult {
  ok: true;
}

const exchanges = new Map<string, Promise<CallbackResult>>();

function exchangeOnce(key: string, run: () => Promise<CallbackResult>): Promise<CallbackResult> {
  const existing = exchanges.get(key);
  if (existing) return existing;
  const promise = run().catch((error: unknown) => {
    exchanges.delete(key);
    throw error;
  });
  exchanges.set(key, promise);
  return promise;
}

async function postCallback(code: string, state: string): Promise<CallbackResult> {
  const response = await apiFetch("/api/bank/connections/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, state }),
  });
  return readJson<CallbackResult>(response, "Pankin vahvistus epäonnistui");
}

function BankCallback() {
  const params = useSearchParams();
  const router = useRouter();
  const code = params.get("code") || "";
  const state = params.get("state") || "";
  const bankError = params.get("error");
  // An "app1."-prefixed state means an app-started consent. On the WEB
  // build (the server's own copy of this page, which the bank actually
  // redirects to) that means bouncing straight into the app via
  // lashkirja://. Inside the MOBILE bundle, ShellGate's deep-link handler
  // has already done that bounce and routed here itself (Task 11) -- this
  // is now just the app's own callback screen, so it proceeds exactly like
  // a web-started flow: POST the code/state with the bearer token.
  const isAppReturn = !IS_MOBILE_BUILD && isAppBankState(state);
  const initial = classifyBankReturn({ code, state, error: bankError });
  const [phase, setPhase] = useState<"working" | "done" | "error">(
    initial.kind === "success" ? "working" : "error"
  );
  const [message, setMessage] = useState(initial.message);
  // Derived straight from the URL's own search params, so it renders
  // identically on the server and on the client - no state or effect needed
  // just to have a value for the fallback button.
  const rawQuery = params.toString();
  const appUrl = appReturnUrl(rawQuery ? `?${rawQuery}` : "");

  // App-started consent: this page's only job is to bounce back into the
  // app. The bundled callback page (inside the app) does the actual
  // POST /api/bank/connections/callback with the bearer token.
  useEffect(() => {
    if (!isAppReturn) return;
    window.location.replace(appUrl);
  }, [appUrl, isAppReturn]);

  useEffect(() => {
    if (isAppReturn) return;
    if (initial.kind !== "success") clearBankAuth();
  }, [initial.kind, isAppReturn]);

  useEffect(() => {
    if (isAppReturn) return;
    if (initial.kind !== "success") return;
    let cancelled = false;
    const key = `${code}:${state}`;
    exchangeOnce(key, () => postCallback(code, state))
      .then(() => {
        if (cancelled) return;
        clearBankAuth();
        setPhase("done");
        setMessage("Pankki yhdistetty. Valitse tilit, jotka kuuluvat kirjanpitoon.");
        window.setTimeout(() => router.replace("/kirjanpito/pankkitilit#pankkiyhteys"), 700);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        clearBankAuth();
        setPhase("error");
        setMessage(errorMessage(error, "Pankin vahvistus epäonnistui"));
      });
    return () => {
      cancelled = true;
    };
  }, [code, initial.kind, isAppReturn, router, state]);

  if (isAppReturn) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
        <Card className="w-full max-w-md">
          <DetailHero title="Pankkiyhteys" meta={<span role="status">Palataan LashKirjaan...</span>} />
          <a href={appUrl} className={buttonClass("primary", "w-full")}>
            Palaa LashKirjaan
          </a>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <Card className="w-full max-w-md">
        <DetailHero
          title="Pankkiyhteys"
          meta={
            <span role={phase === "error" ? "alert" : "status"} className={phase === "error" ? "text-danger" : undefined}>
              {message}
            </span>
          }
        />
        {phase !== "working" && (
          <Link href="/kirjanpito/pankkitilit#pankkiyhteys" className={buttonClass("primary", "w-full")}>
            Takaisin pankkitileihin
          </Link>
        )}
      </Card>
    </main>
  );
}

export default function BankCallbackPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center bg-canvas px-4">
          <p className="text-sm text-ink-2">Yhdistetään pankkiin...</p>
        </main>
      }
    >
      <BankCallback />
    </Suspense>
  );
}
