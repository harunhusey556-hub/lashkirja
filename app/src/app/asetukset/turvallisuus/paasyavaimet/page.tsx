"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import ConfirmModal from "@/components/ConfirmModal";
import { ErrorState } from "@/components/AsyncState";
import { controlClass, tintedButtonClass } from "@/components/control-styles";
import { Card, Icon, PageTitle, Skeleton, SkeletonCard, SkeletonGroup, useSkeletonFade } from "@/components/ds";
import { Button } from "@/components/ui";
import { hapticNotify } from "@/lib/haptics";
import { showToast } from "@/lib/toast";
import {
  createPasskey,
  deletePasskey,
  listPasskeys,
  passkeyFailureMessage,
  passkeysAvailable,
  renamePasskey,
  type PasskeyRow,
} from "@/lib/passkey-client";

function formatDate(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleDateString("fi-FI", { timeZone: "Europe/Helsinki" });
}

function rowDetail(row: PasskeyRow): string {
  const created = `Luotu ${formatDate(row.createdAt)}`;
  return row.lastUsedAt ? `${created} · Käytetty viimeksi ${formatDate(row.lastUsedAt)}` : `${created} · Ei vielä käytetty`;
}

/** OWN-21: passkeys are an extra way to sign in; the password stays. */
export default function PaasyavaimetPage() {
  const [rows, setRows] = useState<PasskeyRow[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [canCreate, setCanCreate] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string; error: string; saving: boolean } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PasskeyRow | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const fade = useSkeletonFade(rows === null && failure === null);

  const load = useCallback(async () => {
    setFailure(null);
    try {
      setRows(await listPasskeys());
    } catch (error: unknown) {
      setFailure(error ?? new Error("load"));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: the passkey list is an external source this effect syncs
    void load();
    let cancelled = false;
    void passkeysAvailable().then((ready) => {
      if (!cancelled) setCanCreate(ready);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (editing && !editing.saving) editInputRef.current?.focus();
  }, [editing]);

  async function create() {
    if (creating) return;
    setCreating(true);
    setMessage("");
    const result = await createPasskey();
    setCreating(false);
    if (result.ok) {
      setRows((current) => [...(current ?? []), result.value]);
      void hapticNotify("success");
      showToast({ tone: "success", text: "Pääsyavain luotu.", haptic: false });
      return;
    }
    const text = passkeyFailureMessage(result.reason, "create", result.message);
    if (text) {
      void hapticNotify("error");
      setMessage(text);
    }
  }

  async function saveName() {
    if (!editing || editing.saving) return;
    const name = editing.name.trim();
    if (!name) {
      setEditing({ ...editing, error: "Anna nimi." });
      return;
    }
    setEditing({ ...editing, saving: true, error: "" });
    try {
      await renamePasskey(editing.id, name);
      setRows((current) => (current ?? []).map((row) => (row.id === editing.id ? { ...row, deviceName: name } : row)));
      setEditing(null);
      void hapticNotify("success");
      showToast({ tone: "success", text: "Nimi tallennettu.", haptic: false });
    } catch (error: unknown) {
      setEditing({ ...editing, saving: false, error: error instanceof Error ? error.message : "Nimen vaihto epäonnistui." });
    }
  }

  if (failure !== null) {
    return (
      <div className="space-y-6">
        <PageTitle title="Pääsyavaimet" />
        <ErrorState error={failure} message="Pääsyavaimia ei saatu ladattua" onRetry={() => void load()} />
      </div>
    );
  }

  if (rows === null) {
    return (
      <div className="space-y-6">
        <PageTitle title="Pääsyavaimet" />
        <SkeletonGroup label="Ladataan pääsyavaimia">
          <SkeletonCard className="space-y-4">
            {[0, 1].map((row) => (
              <div key={row} className="space-y-2">
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="h-3 w-3/5" tone="soft" />
              </div>
            ))}
          </SkeletonCard>
        </SkeletonGroup>
      </div>
    );
  }

  return (
    <div className={`space-y-6 ${fade}`.trim()}>
      <PageTitle title="Pääsyavaimet" />
      <Card className="space-y-4">
        <p className="text-caption leading-relaxed text-ink-2">
          Pääsyavaimella kirjaudut Face ID:llä tai Touch ID:llä ilman salasanaa. Salasana toimii edelleen varalla.
        </p>

        {rows.length > 0 ? (
          <ul className="divide-y divide-line" aria-label="Tallennetut pääsyavaimet">
            {rows.map((row) =>
              editing?.id === row.id ? (
                <li key={row.id} className="space-y-2 py-3">
                  <label htmlFor="passkey-name" className="block text-caption text-ink-2">
                    Pääsyavaimen nimi
                  </label>
                  <input
                    ref={editInputRef}
                    id="passkey-name"
                    type="text"
                    maxLength={60}
                    autoComplete="off"
                    enterKeyHint="done"
                    className={`${controlClass}${editing.error ? " !border-danger" : ""}`}
                    value={editing.name}
                    aria-invalid={editing.error ? true : undefined}
                    aria-describedby={editing.error ? "passkey-name-error" : undefined}
                    disabled={editing.saving}
                    onChange={(event) => setEditing({ ...editing, name: event.target.value, error: "" })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveName();
                      }
                      if (event.key === "Escape") setEditing(null);
                    }}
                  />
                  {editing.error && (
                    <p id="passkey-name-error" role="alert" className="text-sm text-danger">
                      {editing.error}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button type="button" className="flex-1" busy={editing.saving} busyLabel="Tallennetaan…" onClick={() => void saveName()}>
                      Tallenna
                    </Button>
                    <Button type="button" variant="secondary" className="flex-1" disabled={editing.saving} onClick={() => setEditing(null)}>
                      Peru
                    </Button>
                  </div>
                </li>
              ) : (
                <li key={row.id} className="flex items-start gap-3 pt-3 pb-1">
                  <Icon icon={KeyRound} size="row" className="mt-0.5 shrink-0 text-ink-2" />
                  <div className="min-w-0 flex-1">
                    <span className="block clamp-lines [overflow-wrap:anywhere] text-body text-ink">{row.deviceName}</span>
                    <span className="block text-caption text-ink-2">{rowDetail(row)}</span>
                    <div className="-ml-2 flex gap-2">
                      <button
                        type="button"
                        className={tintedButtonClass("accent")}
                        onClick={() => setEditing({ id: row.id, name: row.deviceName, error: "", saving: false })}
                        aria-label={`Nimeä uudelleen: ${row.deviceName}`}
                      >
                        Nimeä
                      </button>
                      <button
                        type="button"
                        className={tintedButtonClass("danger")}
                        onClick={() => setPendingDelete(row)}
                        aria-label={`Poista: ${row.deviceName}`}
                      >
                        Poista
                      </button>
                    </div>
                  </div>
                </li>
              )
            )}
          </ul>
        ) : (
          <p className="py-1 text-body text-ink-2">Ei pääsyavaimia vielä.</p>
        )}

        {canCreate && (
          <Button type="button" className="w-full" busy={creating} busyLabel="Luodaan…" onClick={() => void create()}>
            <span className="inline-flex items-center gap-2">
              <Icon icon={KeyRound} size="inline" />
              Luo pääsyavain
            </span>
          </Button>
        )}
        {canCreate === false && (
          <p className="text-caption leading-relaxed text-ink-2">
            Tällä laitteella ei voi luoda pääsyavainta juuri nyt: palvelinta ei ole vielä määritetty pääsyavaimille tai laite ei tue niitä. Kirjaudu salasanalla.
          </p>
        )}
        {message && (
          <p role="alert" className="text-sm text-danger">
            {message}
          </p>
        )}
      </Card>

      <ConfirmModal
        isOpen={pendingDelete !== null}
        title="Poistetaanko pääsyavain?"
        description={
          pendingDelete
            ? `${pendingDelete.deviceName} ei enää kirjaa sinua sisään. Poista se myös laitteen salasanoista, jos et tarvitse sitä. Salasana toimii edelleen.`
            : undefined
        }
        confirmLabel="Poista"
        onConfirm={async () => {
          if (!pendingDelete) return;
          try {
            await deletePasskey(pendingDelete.id);
            setRows((current) => (current ?? []).filter((row) => row.id !== pendingDelete.id));
            void hapticNotify("success");
            showToast({ tone: "success", text: "Pääsyavain poistettu.", haptic: false });
          } catch (error: unknown) {
            showToast({ tone: "error", text: error instanceof Error ? error.message : "Poisto epäonnistui." });
          }
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
