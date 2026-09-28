"use client";

import { useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import { apiFetch, errorMessage } from "@/components/clientFetch";
import { useProfile } from "../useProfile";
import { Card, PageTitle } from "@/components/ds";
import { controlClass } from "@/components/control-styles";

type ProviderType = "gmail" | "outlook" | "icloud" | "other" | null;

export default function SahkopostiPage() {
  const { profile, setProfile, loadError, retry } = useProfile();

  const [isAddingEmail, setIsAddingEmail] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<ProviderType>(null);
  const [imapEmail, setImapEmail] = useState("");
  const [imapPass, setImapPass] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapSaving, setImapSaving] = useState(false);
  const [imapMsg, setImapMsg] = useState("");
  const [accountToDisconnect, setAccountToDisconnect] = useState<string | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  async function handleEmergencySync() {
    if (syncing) return;
    setSyncing(true);
    setSyncMsg("Etsitään kuitteja...");
    try {
      const res = await apiFetch("/api/integrations/imap/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Synkronointi epäonnistui");
      setSyncMsg(`Synkronoitu onnistuneesti! Löydettiin ${data.count} uutta kuittia.`);
    } catch (err: unknown) {
      setSyncMsg(errorMessage(err, "Synkronointi epäonnistui"));
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(""), 6000);
    }
  }

  const renderProviderInstructions = () => {
    switch (selectedProvider) {
      case "gmail":
        return (
          <div className="space-y-2 rounded-card border border-line bg-canvas p-4 text-[13px] text-ink">
            <p className="font-medium">Näin luot Google-sovellussalasanan:</p>
            <ol className="list-decimal space-y-1 pl-4 text-ink-2">
              <li>Mene <b>Google-tilin asetuksiin</b> (myaccount.google.com).</li>
              <li>Valitse <b>Tietoturva</b> (Security). Varmista, että 2-vaiheinen vahvistus on päällä.</li>
              <li>Hae asetuksista <b>Sovellussalasanat</b> (App Passwords) ja luo uusi.</li>
              <li>Kopioi 16-kirjaiminen koodi alle.</li>
            </ol>
          </div>
        );
      case "outlook":
        return (
          <div className="space-y-2 rounded-card border border-line bg-canvas p-4 text-[13px] text-ink">
            <p className="font-medium">Näin luot Microsoft-sovellussalasanan:</p>
            <ol className="list-decimal space-y-1 pl-4 text-ink-2">
              <li>Mene <b>Microsoft-tilin turva-asetuksiin</b>.</li>
              <li>Valitse <b>Lisäsuojausasetukset</b> (Advanced security options).</li>
              <li>Varmista, että kaksivaiheinen todennus on käytössä.</li>
              <li>Valitse &quot;Luo uusi sovellussalasana&quot; (Create a new app password).</li>
            </ol>
          </div>
        );
      case "icloud":
        return (
          <div className="space-y-2 rounded-card border border-line bg-canvas p-4 text-[13px] text-ink">
            <p className="font-medium">Näin luot Apple-sovellussalasanan:</p>
            <ol className="list-decimal space-y-1 pl-4 text-ink-2">
              <li>Kirjaudu sisään osoitteessa <b>appleid.apple.com</b>.</li>
              <li>Mene <b>Sisäänkirjautuminen ja suojaus</b> -osioon.</li>
              <li>Valitse <b>Appikohtaiset salasanat</b>.</li>
              <li>Luo uusi salasana sovellukselle ja kopioi se alle.</li>
            </ol>
          </div>
        );
      default:
        return (
          <p className="text-[13px] text-ink-2">
            Täytä IMAP-palvelimen tiedot ja sovellussalasana. Varmista sähköpostintarjoajaltasi IMAP-asetukset.
          </p>
        );
    }
  };

  const handleProviderSelect = (provider: ProviderType) => {
    setSelectedProvider(provider);
    setImapMsg("");
    if (provider === "gmail") {
      setImapHost("imap.gmail.com");
      setImapPort("993");
    } else if (provider === "outlook") {
      setImapHost("outlook.office365.com");
      setImapPort("993");
    } else if (provider === "icloud") {
      setImapHost("imap.mail.me.com");
      setImapPort("993");
    } else {
      setImapHost("");
      setImapPort("993");
    }
  };

  const cancelAdding = () => {
    setIsAddingEmail(false);
    setSelectedProvider(null);
    setImapMsg("");
    setImapEmail("");
    setImapPass("");
  };

  if (loadError) {
    return (
      <>
        <ErrorState message={loadError} onRetry={retry} />
      </>
    );
  }

  if (!profile) {
    return (
      <>
        <LoadingState label="Ladataan asetuksia..." />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Sähköpostien tuonti" />
      <Card className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[15px] font-medium text-ink">Sähköpostiautomaatio</h3>
            <p className="mt-1 text-[13px] text-ink-2">
              Yhdistä sähköpostiosoitteesi, niin sovellus hakee ja analysoi automaattisesti siihen saapuneet kuitit.
            </p>
          </div>
          {profile.imapAccounts.length > 0 && (
            <button
              type="button"
              onClick={handleEmergencySync}
              disabled={syncing}
              className="active-press touch-target shrink-0 self-start rounded-card bg-ink px-4 py-2 text-xs font-medium text-canvas disabled:opacity-50"
            >
              {syncing ? "Synkronoidaan..." : "Synkronoi kuitit nyt"}
            </button>
          )}
        </div>

        {syncMsg && (
          <div
            className={`rounded-card p-3 text-sm ${
              syncMsg.includes("epäonnistui") ? "bg-danger/10 text-danger" : "bg-success/10 text-success"
            }`}
          >
            {syncMsg}
          </div>
        )}

        {profile.imapAccounts.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-[13px] text-ink-2">Yhdistetyt tilit</h4>
            {profile.imapAccounts.map((account) => (
              <div
                key={account.id}
                className="flex items-center justify-between rounded-card border border-success/30 bg-success/5 p-4"
              >
                <div>
                  <p className="text-sm font-medium text-success">Aktiivinen</p>
                  <p className="mt-0.5 text-xs text-ink">{account.email}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setAccountToDisconnect(account.id)}
                  className="active-press touch-target text-xs font-medium text-danger"
                >
                  Katkaise yhteys
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-line pt-4">
          {!isAddingEmail && profile.imapAccounts.length > 0 ? (
            <button
              type="button"
              onClick={() => setIsAddingEmail(true)}
              className="active-press touch-target flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-line py-3 text-[13px] font-medium text-ink"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-4 w-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Lisää toinen sähköpostitili
            </button>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h4 className="text-[13px] text-ink-2">
                  {profile.imapAccounts.length > 0 ? "Lisää uusi sähköpostitili" : "Yhdistä sähköpostitili"}
                </h4>
                {profile.imapAccounts.length > 0 && (
                  <button type="button" onClick={cancelAdding} className="active-press touch-target text-xs font-medium text-ink-2">
                    Peruuta
                  </button>
                )}
              </div>

              {!selectedProvider ? (
                <div className="grid grid-cols-2 gap-3">
                  {(
                    [
                      ["gmail", "Gmail"],
                      ["outlook", "Outlook / Hotmail"],
                      ["icloud", "iCloud"],
                      ["other", "Muu IMAP"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => handleProviderSelect(value)}
                      className="active-press touch-target flex flex-col items-center justify-center rounded-card border border-line p-4"
                    >
                      <span className="text-[13px] font-medium text-ink">{label}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-5">
                  {renderProviderInstructions()}

                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (imapSaving) return;
                      setImapSaving(true);
                      setImapMsg("Yhdistetään ja testataan...");
                      try {
                        const res = await apiFetch("/api/integrations/imap", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            email: imapEmail,
                            password: imapPass,
                            host: imapHost,
                            port: parseInt(imapPort, 10),
                          }),
                        });
                        const json = await res.json();
                        if (!res.ok) throw new Error(json.error || "Yhdistäminen epäonnistui");
                        setProfile({
                          ...profile,
                          imapAccounts: [
                            ...profile.imapAccounts,
                            { id: Math.random().toString(), email: json.email },
                          ],
                        });
                        cancelAdding();
                      } catch (err: unknown) {
                        setImapMsg(errorMessage(err, "Tallennus epäonnistui"));
                      } finally {
                        setImapSaving(false);
                      }
                    }}
                    className="space-y-4"
                  >
                    {selectedProvider === "other" && (
                      <div className="grid grid-cols-[1fr_100px] gap-3">
                        <div>
                          <label className="mb-1.5 block text-[13px] text-ink-2">IMAP Palvelin</label>
                          <input
                            type="text"
                            placeholder="esim. imap.omaverkko.fi"
                            value={imapHost}
                            onChange={(e) => setImapHost(e.target.value)}
                            className={controlClass}
                            required
                          />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-[13px] text-ink-2">Portti</label>
                          <input
                            type="number"
                            value={imapPort}
                            onChange={(e) => setImapPort(e.target.value)}
                            className={controlClass}
                            required
                          />
                        </div>
                      </div>
                    )}

                    <div>
                      <label className="mb-1.5 block text-[13px] text-ink-2">Sähköpostiosoite</label>
                      <input
                        type="email"
                        value={imapEmail}
                        onChange={(e) => setImapEmail(e.target.value)}
                        className={controlClass}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        required
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-[13px] text-ink-2">Sovellussalasana</label>
                      <input
                        type="password"
                        value={imapPass}
                        onChange={(e) => setImapPass(e.target.value)}
                        className={controlClass}
                        required
                      />
                    </div>

                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => setSelectedProvider(null)}
                        className="active-press touch-target rounded-card border border-line px-4 py-2.5 text-[13px] font-medium text-ink"
                      >
                        Takaisin
                      </button>
                      <button
                        type="submit"
                        disabled={imapSaving || !imapEmail || !imapPass || !imapHost}
                        aria-describedby={!imapEmail || !imapPass || !imapHost ? "imap-connect-reason" : undefined}
                        className="active-press touch-target flex-1 rounded-card bg-ink py-2.5 text-[13px] font-medium text-canvas disabled:opacity-50"
                      >
                        {imapSaving ? "Yhdistetään..." : "Yhdistä"}
                      </button>
                    </div>
                    {(!imapEmail || !imapPass || !imapHost) && (
                      <p id="imap-connect-reason" className="text-xs text-ink-2">
                        Täytä sähköposti, salasana ja palvelin.
                      </p>
                    )}
                    {imapSaving && (
                      <p className="text-xs text-ink-2" role="status">
                        Yhdistäminen on kesken.
                      </p>
                    )}

                    {imapMsg && <p className="text-xs text-danger">{imapMsg}</p>}
                  </form>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      <ConfirmModal
        isOpen={accountToDisconnect !== null}
        title="Katkaise yhteys?"
        description="Oletko varma, että haluat katkaista yhteyden tähän sähköpostitiliin? Tulevia kuitteja ei enää tuoda automaattisesti."
        confirmLabel="Katkaise yhteys"
        onConfirm={async () => {
          if (!accountToDisconnect) return;
          const id = accountToDisconnect;
          try {
            const res = await apiFetch(`/api/integrations/imap?id=${id}`, { method: "DELETE" });
            if (!res.ok) {
              const message = "Yhteyden katkaisu epäonnistui. Yritä uudelleen.";
              setSyncMsg(message);
              throw new Error(message);
            }
            setProfile({
              ...profile,
              imapAccounts: profile.imapAccounts.filter((a) => a.id !== id),
            });
            setAccountToDisconnect(null);
          } catch (error) {
            if (error instanceof Error && error.message) throw error;
            const message = "Yhteyden katkaisu epäonnistui. Tarkista verkkoyhteys ja yritä uudelleen.";
            setSyncMsg(message);
            throw new Error(message);
          }
        }}
        onCancel={() => setAccountToDisconnect(null)}
      />
    </div>
  );
}
