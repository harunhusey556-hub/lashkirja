"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { AuthedFileLink } from "@/components/AuthedFileLink";
import { Card, PageTitle } from "@/components/ds";
import { Button, Field } from "@/components/ui";
import { controlClass } from "@/components/control-styles";
import { ACCOUNTING_RETENTION_YEARS } from "@/lib/session-policy";

// Extends a small inline text link's touch target to >=44px tall without
// growing what's actually drawn (same trick as kirjanpito/alv/page.tsx's
// own HIT44, with a slightly bigger inset: this row's ~19px text line
// needs +13px each side, not +12px, to actually clear 44px).
const HIT44 = "relative before:absolute before:inset-x-0 before:-inset-y-[13px] before:content-['']";

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
      <PageTitle title="Tietosuoja" />

      <Card className="space-y-3 text-[15px] text-ink leading-relaxed">
        <h2 className="text-[13px] text-ink-2">Mitä LashKirja säilyttää</h2>
        <p>
          Tilillä ovat nimesi, sähköpostisi ja salasanan tiiviste, yrityksen laskutustiedot,
          kuitit ja niiden tiedostot, tiliotteet, pankkitilit, asiakkaat, laskut, maksut ja
          keskustelut avustajan kanssa.
        </p>
        <h2 className="pt-2 text-[13px] text-ink-2">Avustaja</h2>
        <p>
          Ilman kielimallin avainta vastaukset syntyvät palvelimella, ja näyttö kertoo rajatun tilan.
          Kun avain on asetettu, kysymys ja aiemmat viestit samassa keskustelussa lähtevät
          GitHub Copilot -palveluun. Pankkiyhteyden salaisuuksia ei laiteta viestiin.
        </p>
        <h2 className="pt-2 text-[13px] text-ink-2">Säilytys</h2>
        <p>
          Kirjanpitoaineistoa säilytetään {ACCOUNTING_RETENTION_YEARS} vuotta tilikauden päättymisestä.
          Tilin sulkeminen ei poista kuitteja tai laskuja heti.
        </p>
        <p>
          Kuukauden viennin zip löytyy{" "}
          <Link href="/raportit" className={`text-accent ${HIT44}`}>
            Raporteista
          </Link>
          .
        </p>
      </Card>

      <form className="space-y-4" onSubmit={(event) => event.preventDefault()}>
        <Card className="space-y-4">
          <div>
            <h2 className="text-[15px] font-medium text-ink">Pyyntö tuelle</h2>
            <p className="mt-1 text-[13px] text-ink-2 leading-relaxed">
              Nykyinen salasana vahvistaa, että pyyntö tulee sinulta. Tuki käsittelee sen. Aineistoa ei tuhota
              tästä näkymästä. Sulkeminen estää kirjautumisen, kun pyyntö on valmis. Kuitit ja laskut säilyvät.
            </p>
          </div>
          {requests.length > 0 && (
            <ul className="divide-y divide-line text-[15px]">
              {requests.map((row) => (
                <li key={row.id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-ink">{row.kindLabel}</span>
                    <span className="block text-[13px] text-ink-2">{row.statusLabel}</span>
                  </span>
                  {row.downloadable && (
                    <AuthedFileLink
                      className="active-press inline-flex min-h-11 items-center text-accent"
                      href={`/api/account/request/${row.id}/package`}
                      fallbackName="tietokopio.zip"
                      title="Tietokopio"
                    >
                      Lataa
                    </AuthedFileLink>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Field label="Nykyinen salasana" htmlFor="privacyPassword">
            <input
              id="privacyPassword"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={controlClass}
            />
          </Field>
          {message && (
            <p className="text-sm text-ink-2" role="status">
              {message}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              className="w-full"
              busy={busy === "export"}
              busyLabel="Lähetetään…"
              onClick={() => void request("export")}
            >
              Pyydä kopio tiedoista
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              busy={busy === "close"}
              busyLabel="Lähetetään…"
              onClick={() => void request("close")}
            >
              Pyydä tilin sulkemista
            </Button>
          </div>
        </Card>
      </form>
    </div>
  );
}
