"use client";

import { useEffect, useState } from "react";
import { apiFetch, errorMessage, leaveAfterSignOut, readJson } from "@/components/clientFetch";
import { Button } from "@/components/ui";

interface SessionRow {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export default function LaitteetPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionError, setSessionError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void apiFetch("/api/auth/sessions")
      .then((response) => readJson<{ sessions: SessionRow[] }>(response, "Istuntoja ei saatu ladattua"))
      .then((data) => {
        if (!cancelled) setSessions(data.sessions);
      })
      .catch((error: unknown) => {
        if (!cancelled) setSessionError(errorMessage(error, "Istuntoja ei saatu ladattua"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function revoke(body: { scope?: "others" | "all"; id?: string }) {
    setSessionError("");
    try {
      const response = await apiFetch("/api/auth/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readJson<{ signedOut: boolean }>(response, "Istunnon sulkeminen epäonnistui");
      if (data.signedOut) {
        const left = await leaveAfterSignOut();
        if (!left) setSessionError("Uloskirjautuminen epäonnistui. Istunto voi olla yhä voimassa.");
        return;
      }
      setSessions((current) =>
        body.id ? current.filter((row) => row.id !== body.id) : current.filter((row) => row.current)
      );
    } catch (error: unknown) {
      setSessionError(errorMessage(error, "Istunnon sulkeminen epäonnistui"));
    }
  }

  return (
    <section className="bg-white rounded-2xl p-6 shadow-sm space-y-3">
      <h2 className="text-sm font-medium text-charcoal">Laitteet</h2>
      <p className="text-sm text-warm-gray">
        Lista näyttää kirjautumiset, joissa istunto on tallennettu. Vanha selain ilman tunnistetta pysyy, kunnes kirjaudut ulos.
      </p>
      {sessionError && (
        <p className="text-sm text-danger" role="alert">
          {sessionError}
        </p>
      )}
      <ul className="divide-y divide-warm-gray-light/30">
        {sessions.map((row) => (
          <li key={row.id} className="py-3 flex items-center gap-3">
            <span className="flex-1 min-w-0">
              <span className="block text-sm text-charcoal">{row.label}</span>
              <span className="block text-xs text-warm-gray">{row.current ? "Tämä laite" : "Muu laite"}</span>
            </span>
            {!row.current && (
              <button
                type="button"
                className="text-sm text-danger min-h-11 px-2"
                onClick={() => void revoke({ id: row.id })}
              >
                Sulje
              </button>
            )}
          </li>
        ))}
      </ul>
      <Button type="button" variant="secondary" onClick={() => void revoke({ scope: "others" })}>
        Sulje muut laitteet
      </Button>
    </section>
  );
}
