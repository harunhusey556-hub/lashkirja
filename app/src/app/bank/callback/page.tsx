"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { buttonClass } from "@/components/control-styles";
import { Card, DetailHero } from "@/components/ds";
import { classifyBankReturn } from "@/lib/bank-return";
import { clearBankAuth } from "@/lib/open-bank-auth";

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
  const initial = classifyBankReturn({ code, state, error: bankError });
  const [phase, setPhase] = useState<"working" | "done" | "error">(
    initial.kind === "success" ? "working" : "error"
  );
  const [message, setMessage] = useState(initial.message);

  useEffect(() => {
    if (initial.kind !== "success") clearBankAuth();
  }, [initial.kind]);

  useEffect(() => {
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
  }, [code, initial.kind, router, state]);

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
