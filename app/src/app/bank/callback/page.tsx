"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";

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
  const [phase, setPhase] = useState<"working" | "done" | "error">(
    bankError || !code || !state ? "error" : "working"
  );
  const [message, setMessage] = useState(() => {
    if (bankError === "access_denied") return "Yhdistäminen peruutettiin.";
    if (bankError) return "Pankki ei vahvistanut yhteyttä. Yritä uudelleen.";
    if (!code || !state) return "Pankin paluuosoitteesta puuttui vahvistus. Yhdistä uudelleen.";
    return "Yhdistetään pankkiin...";
  });

  useEffect(() => {
    if (!code || !state || bankError) return;
    let cancelled = false;
    const key = `${code}:${state}`;
    exchangeOnce(key, () => postCallback(code, state))
      .then(() => {
        if (cancelled) return;
        setPhase("done");
        setMessage("Pankki yhdistetty. Valitse tilit, jotka kuuluvat kirjanpitoon.");
        window.setTimeout(() => router.replace("/asetukset#pankkiyhteys"), 700);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setPhase("error");
        setMessage(errorMessage(error, "Pankin vahvistus epäonnistui"));
      });
    return () => {
      cancelled = true;
    };
  }, [bankError, code, router, state]);

  return (
    <main className="min-h-dvh bg-cream flex items-center justify-center px-4 py-10">
      <section className="w-full max-w-md bg-white rounded-3xl shadow-sm p-6 space-y-4">
        <h1 className="text-xl font-medium text-charcoal">Pankkiyhteys</h1>
        <p
          className={`text-sm leading-relaxed ${phase === "error" ? "text-danger" : "text-warm-gray"}`}
          role={phase === "error" ? "alert" : "status"}
        >
          {message}
        </p>
        {phase === "error" && (
          <a
            href="/asetukset#pankkiyhteys"
            className="inline-flex w-full justify-center px-4 py-3 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-dark"
          >
            Takaisin asetuksiin
          </a>
        )}
      </section>
    </main>
  );
}

export default function BankCallbackPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-dvh bg-cream flex items-center justify-center px-4">
          <p className="text-sm text-warm-gray">Yhdistetään pankkiin...</p>
        </main>
      }
    >
      <BankCallback />
    </Suspense>
  );
}
