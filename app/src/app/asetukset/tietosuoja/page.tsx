"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ConfirmModal from "@/components/ConfirmModal";
import { ApiError, apiFetch, errorMessage, isUserFacingMessage, readJson } from "@/components/clientFetch";
import { AuthedFileLink } from "@/components/AuthedFileLink";
import { Card, PageTitle } from "@/components/ds";
import { PasswordField } from "@/components/ds/PasswordField";
import { useSession } from "@/components/SessionProvider";
import { Button, FormError } from "@/components/ui";
import { hapticNotify } from "@/lib/haptics";
import { showToast } from "@/lib/toast";
import { ACCOUNTING_RETENTION_YEARS } from "@/lib/session-policy";

interface AccountRequestRow {
  id: string;
  kindLabel: string;
  statusLabel: string;
  downloadable: boolean;
  createdAt: string;
}

type RequestKind = "close" | "export";

export default function TietosuojaPage() {
  const { user } = useSession();
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState<RequestKind | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [requests, setRequests] = useState<AccountRequestRow[]>([]);
  const [requestsFailed, setRequestsFailed] = useState(false);

  const loadRequests = useCallback(async () => {
    try {
      const response = await apiFetch("/api/account/request");
      const data = await readJson<{ requests: AccountRequestRow[] }>(response, "Pyyntöjä ei saatu ladattua");
      setRequests(data.requests ?? []);
      setRequestsFailed(false);
    } catch {
      setRequestsFailed(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: the request list is an external source this effect syncs
    void loadRequests();
  }, [loadRequests]);

  /** Returns true when the request was recorded. */
  async function sendRequest(kind: RequestKind): Promise<boolean> {
    setBusy(kind);
    setPasswordError("");
    setFormError("");
    try {
      const response = await apiFetch("/api/account/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, currentPassword: password }),
      });
      const data = await readJson<{ message: string }>(response, "Pyyntö epäonnistui");
      setPassword("");
      showToast({
        tone: "success",
        text: data.message && isUserFacingMessage(data.message) ? data.message : "Pyyntö on kirjattu.",
        durationMs: 8000,
      });
      await loadRequests();
      return true;
    } catch (error: unknown) {
      void hapticNotify("error");
      // 401 from this endpoint means the password was wrong (a dead session
      // would also say 401, and the shell's own check handles that one).
      if (error instanceof ApiError && error.status === 401) {
        setPasswordError(errorMessage(error, "Salasana ei täsmää."));
        document.getElementById("privacyPassword")?.focus();
      } else {
        setFormError(errorMessage(error, "Pyyntö epäonnistui"));
      }
      return false;
    } finally {
      setBusy(null);
    }
  }

  /** The password is required for both requests: no request leaves without it (AUTH-04). */
  function requirePassword(): boolean {
    if (password) return true;
    setPasswordError("Kirjoita nykyinen salasana.");
    void hapticNotify("error");
    document.getElementById("privacyPassword")?.focus();
    return false;
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Tietosuoja" />

      <Card className="space-y-3 text-body text-ink">
        <h2 className="text-caption text-ink-2">Mitä LashKirja säilyttää</h2>
        <p>
          Tilillä ovat nimesi, sähköpostisi ja salasanan tiiviste, yrityksen laskutustiedot,
          kuitit ja niiden tiedostot, tiliotteet, pankkitilit, asiakkaat, laskut, maksut ja
          keskustelut avustajan kanssa.
        </p>
        <h2 className="pt-2 text-caption text-ink-2">Avustaja</h2>
        <p>
          Kun kysyt avustajalta jotain, kysymys ja saman keskustelun aiemmat viestit lähetetään
          tekoälypalveluun vastauksen muodostamista varten. Pankkiyhteyden salaisuuksia ei lähetetä.
        </p>
        <h2 className="pt-2 text-caption text-ink-2">Säilytys</h2>
        <p>
          Kirjanpitoaineistoa säilytetään {ACCOUNTING_RETENTION_YEARS} vuotta tilikauden päättymisestä.
          Tilin sulkeminen ei poista kuitteja tai laskuja heti.
        </p>
        <p>Kuukauden viennin zip löytyy Raporteista.</p>
        <Link href="/raportit" className="active-press -mt-1 inline-flex min-h-11 items-center text-accent">
          Avaa Raportit
        </Link>
      </Card>

      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          // Enter in the password field asks for the data copy, the harmless request.
          if (busy || !requirePassword()) return;
          void sendRequest("export");
        }}
      >
        <Card className="space-y-4">
          <div>
            <h2 className="text-body font-medium text-ink">Pyyntö tuelle</h2>
            <p className="mt-1 text-caption text-ink-2">
              Nykyinen salasana vahvistaa, että pyyntö tulee sinulta. Tuki käsittelee sen. Aineistoa ei tuhota
              tästä näkymästä. Sulkeminen estää kirjautumisen, kun pyyntö on valmis. Kuitit ja laskut säilyvät.
            </p>
          </div>
          {requestsFailed && (
            <div className="flex items-center justify-between gap-3 rounded-card bg-danger/10 p-3 text-caption text-danger" role="alert">
              <span>Aiempia pyyntöjä ei saatu ladattua.</span>
              <button
                type="button"
                onClick={() => void loadRequests()}
                className="active-press flex min-h-11 shrink-0 items-center px-2 font-medium"
              >
                Yritä uudelleen
              </button>
            </div>
          )}
          {requests.length > 0 && (
            <ul className="divide-y divide-line text-body">
              {requests.map((row) => (
                <li key={row.id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-ink">{row.kindLabel}</span>
                    <span className="block text-caption text-ink-2">{row.statusLabel}</span>
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
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={user?.email ?? ""}
            readOnly
            tabIndex={-1}
            aria-hidden
            className="sr-only"
          />
          <PasswordField
            id="privacyPassword"
            name="privacyPassword"
            label="Nykyinen salasana"
            autoComplete="current-password"
            enterKeyHint="go"
            required
            value={password}
            error={passwordError}
            onChange={(event) => {
              setPassword(event.target.value);
              if (passwordError) setPasswordError("");
            }}
          />
          <FormError message={formError} />
          <div className="flex flex-col gap-2">
            <Button
              type="submit"
              className="w-full"
              disabled={!password || busy === "close"}
              busy={busy === "export"}
              busyLabel="Lähetetään…"
            >
              Pyydä kopio tiedoista
            </Button>
            <Button
              type="button"
              variant="danger"
              className="w-full"
              disabled={!password || busy === "export"}
              busy={busy === "close"}
              busyLabel="Lähetetään…"
              onClick={() => {
                if (requirePassword()) setConfirmClose(true);
              }}
            >
              Pyydä tilin sulkemista
            </Button>
          </div>
        </Card>
      </form>

      <ConfirmModal
        isOpen={confirmClose}
        title="Pyydetäänkö tilin sulkemista?"
        description={`Pyyntö kirjataan tuelle. Kirjautuminen estetään, kun pyyntö on käsitelty. Kirjanpitoaineistoa säilytetään ${ACCOUNTING_RETENTION_YEARS} vuotta tilikauden päättymisestä.`}
        confirmLabel="Pyydä sulkemista"
        onConfirm={async () => {
          const ok = await sendRequest("close");
          if (!ok) throw new Error("Pyyntöä ei voitu kirjata. Tarkista salasana ja yritä uudelleen.");
        }}
        onCancel={() => setConfirmClose(false)}
      />
    </div>
  );
}
