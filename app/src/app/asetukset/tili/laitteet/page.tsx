"use client";

import { useEffect, useState } from "react";
import { apiFetch, errorMessage, leaveAfterSignOut, readJson } from "@/components/clientFetch";
import { Card, PageTitle } from "@/components/ds";
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
    <div className="space-y-6">
      <PageTitle title="Laitteet" />
      <Card className="space-y-3">
        <p className="text-[13px] text-ink-2 leading-relaxed">
          Lista näyttää kirjautumiset, joissa istunto on tallennettu. Vanha selain ilman tunnistetta pysyy, kunnes kirjaudut ulos.
        </p>
        {sessionError && (
          <p className="text-sm text-danger" role="alert">
            {sessionError}
          </p>
        )}
        <ul className="divide-y divide-line">
          {sessions.map((row) => (
            <li key={row.id} className="flex items-center gap-3 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] text-ink">{row.label}</span>
                <span className="block text-[13px] text-ink-2">{row.current ? "Tämä laite" : "Muu laite"}</span>
              </span>
              {!row.current && (
                <button
                  type="button"
                  className="active-press min-h-11 px-2 text-sm text-danger"
                  onClick={() => void revoke({ id: row.id })}
                >
                  Sulje
                </button>
              )}
            </li>
          ))}
        </ul>
        <Button type="button" variant="secondary" className="w-full" onClick={() => void revoke({ scope: "others" })}>
          Sulje muut laitteet
        </Button>
      </Card>
    </div>
  );
}
