"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { Button, controlClass } from "@/components/ui";
import { ACCOUNTING_RETENTION_YEARS } from "@/lib/session-policy";

interface AccountRequestRow {
  id: string;
  kindLabel: string;
  statusLabel: string;
  downloadable: boolean;
  createdAt: string;
}

export default function TietosuojaPage() {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"close" | "export" | null>(null);
  const [requests, setRequests] = useState<AccountRequestRow[]>([]);

  function loadRequests() {
    return apiFetch("/api/account/request")
      .then((response) => readJson<{ requests: AccountRequestRow[] }>(response, "Pyyntöjä ei saatu ladattua"))
      .then((data) => {
        setRequests(data.requests ?? []);
      });
  }

  useEffect(() => {
    let cancelled = false;
    void apiFetch("/api/account/request")
      .then((response) => readJson<{ requests: AccountRequestRow[] }>(response, "Pyyntöjä ei saatu ladattua"))
      .then((data) => {
        if (!cancelled) setRequests(data.requests ?? []);
      })
      .catch(() => {
        if (!cancelled) setRequests([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function request(kind: "close" | "export") {
    setBusy(kind);
    setMessage("");
    try {
      const response = await apiFetch("/api/account/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, currentPassword: password }),
      });
      const data = await readJson<{ message: string }>(response, "Pyyntö epäonnistui");
      setMessage(data.message);
      setPassword("");
      await loadRequests();
    } catch (error: unknown) {
      setMessage(errorMessage(error, "Pyyntö epäonnistui"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="bg-white rounded-2xl p-6 shadow-sm space-y-3 text-sm text-charcoal leading-relaxed">
        <h2 className="font-medium">Mitä LashKirja säilyttää</h2>
        <p>
          Tilillä ovat nimesi, sähköpostisi ja salasanan tiiviste, yrityksen laskutustiedot,
          kuitit ja niiden tiedostot, tiliotteet, pankkitilit, asiakkaat, laskut, maksut ja
          keskustelut avustajan kanssa.
        </p>
        <h2 className="font-medium pt-2">Avustaja</h2>
        <p>
          Ilman kielimallin avainta vastaukset syntyvät palvelimella, ja näyttö kertoo rajatun tilan.
          Kun avain on asetettu, kysymys ja aiemmat viestit samassa keskustelussa lähtevät
          GitHub Copilot -palveluun. Pankkiyhteyden salaisuuksia ei laiteta viestiin.
        </p>
        <h2 className="font-medium pt-2">Säilytys</h2>
        <p>
          Kirjanpitoaineistoa säilytetään {ACCOUNTING_RETENTION_YEARS} vuotta tilikauden päättymisestä.
          Tilin sulkeminen ei poista kuitteja tai laskuja heti.
        </p>
        <p>
          Kuukauden viennin zip löytyy{" "}
          <Link href="/raportit" className="text-accent-dark underline">
            Raporteista
          </Link>
          .
        </p>
      </section>

      <form
        className="bg-white rounded-2xl p-6 shadow-sm space-y-4"
        onSubmit={(event) => event.preventDefault()}
      >
        <h2 className="text-sm font-medium text-charcoal">Pyyntö tuelle</h2>
        <p className="text-sm text-warm-gray">
          Nykyinen salasana vahvistaa, että pyyntö tulee sinulta. Tuki käsittelee sen. Aineistoa ei tuhota tästä näkymästä.
          Sulkeminen estää kirjautumisen, kun pyyntö on valmis. Kuitit ja laskut säilyvät.
        </p>
        {requests.length > 0 && (
          <ul className="divide-y divide-warm-gray-light/30 text-sm">
            {requests.map((row) => (
              <li key={row.id} className="py-2 flex items-center gap-3">
                <span className="flex-1 min-w-0">
                  <span className="block text-charcoal">{row.kindLabel}</span>
                  <span className="block text-warm-gray">{row.statusLabel}</span>
                </span>
                {row.downloadable && (
                  <a className="text-accent-dark underline min-h-11 inline-flex items-center" href={`/api/account/request/${row.id}/package`}>
                    Lataa
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        <label htmlFor="privacyPassword" className="block text-sm font-medium text-charcoal">
          Nykyinen salasana
        </label>
        <input
          id="privacyPassword"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={`${controlClass} min-h-12`}
        />
        {message && (
          <p className="text-sm text-warm-gray" role="status">
            {message}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <Button type="button" busy={busy === "export"} busyLabel="Lähetetään…" onClick={() => void request("export")}>
            Pyydä kopio tiedoista
          </Button>
          <Button
            type="button"
            variant="secondary"
            busy={busy === "close"}
            busyLabel="Lähetetään…"
            onClick={() => void request("close")}
          >
            Pyydä tilin sulkemista
          </Button>
        </div>
      </form>
    </div>
  );
}
