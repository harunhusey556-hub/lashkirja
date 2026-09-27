"use client";

import { useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import { errorMessage } from "@/components/clientFetch";
import { useProfile } from "../useProfile";

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
      const res = await fetch("/api/integrations/imap/sync", { method: "POST" });
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
          <div className="bg-cream/50 p-4 rounded-xl border border-warm-gray-light text-sm text-charcoal space-y-2">
            <p className="font-medium">Näin luot Google-sovellussalasanan:</p>
            <ol className="list-decimal pl-4 space-y-1 text-warm-gray">
              <li>Mene <b>Google-tilin asetuksiin</b> (myaccount.google.com).</li>
              <li>Valitse <b>Tietoturva</b> (Security). Varmista, että 2-vaiheinen vahvistus on päällä.</li>
              <li>Hae asetuksista <b>Sovellussalasanat</b> (App Passwords) ja luo uusi.</li>
              <li>Kopioi 16-kirjaiminen koodi alle.</li>
            </ol>
          </div>
        );
      case "outlook":
        return (
          <div className="bg-cream/50 p-4 rounded-xl border border-warm-gray-light text-sm text-charcoal space-y-2">
            <p className="font-medium">Näin luot Microsoft-sovellussalasanan:</p>
            <ol className="list-decimal pl-4 space-y-1 text-warm-gray">
              <li>Mene <b>Microsoft-tilin turva-asetuksiin</b>.</li>
              <li>Valitse <b>Lisäsuojausasetukset</b> (Advanced security options).</li>
              <li>Varmista, että kaksivaiheinen todennus on käytössä.</li>
              <li>Valitse &quot;Luo uusi sovellussalasana&quot; (Create a new app password).</li>
            </ol>
          </div>
        );
      case "icloud":
        return (
          <div className="bg-cream/50 p-4 rounded-xl border border-warm-gray-light text-sm text-charcoal space-y-2">
            <p className="font-medium">Näin luot Apple-sovellussalasanan:</p>
            <ol className="list-decimal pl-4 space-y-1 text-warm-gray">
              <li>Kirjaudu sisään osoitteessa <b>appleid.apple.com</b>.</li>
              <li>Mene <b>Sisäänkirjautuminen ja suojaus</b> -osioon.</li>
              <li>Valitse <b>Appikohtaiset salasanat</b>.</li>
              <li>Luo uusi salasana sovellukselle ja kopioi se alle.</li>
            </ol>
          </div>
        );
      default:
        return (
          <p className="text-sm text-warm-gray">
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
    <>
      <div className="space-y-6">
        <div className="bg-white rounded-2xl p-6 shadow-sm space-y-6 animate-in">
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-start">
            <div className="min-w-0">
              <h3 className="text-lg font-medium text-charcoal">Sähköpostiautomaatio</h3>
              <p className="text-sm text-warm-gray mt-1">
                Yhdistä sähköpostiosoitteesi, niin sovellus hakee ja analysoi automaattisesti siihen saapuneet kuitit.
              </p>
            </div>
            {profile.imapAccounts.length > 0 && (
              <button
                type="button"
                onClick={handleEmergencySync}
                disabled={syncing}
                className="shrink-0 self-start px-4 py-2 rounded-xl bg-charcoal text-white text-xs font-medium hover:bg-black transition-colors shadow-sm disabled:opacity-50 active-press touch-target"
              >
                {syncing ? "Synkronoidaan..." : "Synkronoi kuitit nyt"}
              </button>
            )}
          </div>

          {syncMsg && (
            <div className={`p-3 rounded-xl text-sm animate-fade-in ${syncMsg.includes("epäonnistui") ? "bg-danger/10 text-danger" : "bg-success/10 text-success"}`}>
              {syncMsg}
            </div>
          )}

          {profile.imapAccounts.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-charcoal-light">Yhdistetyt tilit</h4>
              {profile.imapAccounts.map((account) => (
                <div key={account.id} className="rounded-xl border border-success/30 bg-success/5 p-4 flex justify-between items-center">
                  <div>
                    <p className="text-sm font-medium text-success">Aktiivinen</p>
                    <p className="text-xs text-charcoal mt-0.5">{account.email}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAccountToDisconnect(account.id)}
                    className="text-xs font-medium text-danger hover:underline touch-target"
                  >
                    Katkaise yhteys
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="pt-4 border-t border-warm-gray-light">
            {!isAddingEmail && profile.imapAccounts.length > 0 ? (
              <button
                type="button"
                onClick={() => setIsAddingEmail(true)}
                className="w-full py-3 rounded-xl border border-warm-gray-light border-dashed text-sm font-medium text-charcoal hover:bg-cream transition-colors flex items-center justify-center gap-2 active-press touch-target"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Lisää toinen sähköpostitili
              </button>
            ) : (
              <div className="space-y-6">
                <div className="flex justify-between items-center">
                  <h4 className="text-sm font-medium text-charcoal-light">
                    {profile.imapAccounts.length > 0 ? "Lisää uusi sähköpostitili" : "Yhdistä sähköpostitili"}
                  </h4>
                  {profile.imapAccounts.length > 0 && (
                    <button
                      type="button"
                      onClick={cancelAdding}
                      className="text-xs font-medium text-warm-gray hover:text-charcoal transition-colors touch-target"
                    >
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
                        className="flex flex-col items-center justify-center p-4 rounded-xl border border-warm-gray-light hover:border-accent hover:bg-cream transition-all group active-press touch-target"
                      >
                        <span className="text-sm font-medium text-charcoal group-hover:text-accent">{label}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-5 animate-fade-in">
                    {renderProviderInstructions()}

                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (imapSaving) return;
                        setImapSaving(true);
                        setImapMsg("Yhdistetään ja testataan...");
                        try {
                          const res = await fetch("/api/integrations/imap", {
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
                            <label className="block text-sm font-medium text-charcoal mb-1.5">
                              IMAP Palvelin
                            </label>
                            <input
                              type="text"
                              placeholder="esim. imap.omaverkko.fi"
                              value={imapHost}
                              onChange={(e) => setImapHost(e.target.value)}
                              className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-white text-sm"
                              required
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-charcoal mb-1.5">
                              Portti
                            </label>
                            <input
                              type="number"
                              value={imapPort}
                              onChange={(e) => setImapPort(e.target.value)}
                              className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-white text-sm"
                              required
                            />
                          </div>
                        </div>
                      )}

                      <div>
                        <label className="block text-sm font-medium text-charcoal mb-1.5">
                          Sähköpostiosoite
                        </label>
                        <input
                          type="email"
                          value={imapEmail}
                          onChange={(e) => setImapEmail(e.target.value)}
                          className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-white text-sm"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-charcoal mb-1.5">
                          Sovellussalasana
                        </label>
                        <input
                          type="password"
                          value={imapPass}
                          onChange={(e) => setImapPass(e.target.value)}
                          className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-white text-sm"
                          required
                        />
                      </div>

                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={() => setSelectedProvider(null)}
                          className="px-4 py-2.5 rounded-xl border border-warm-gray-light text-sm font-medium text-charcoal hover:bg-cream transition-colors active-press touch-target"
                        >
                          Takaisin
                        </button>
                        <button
                          type="submit"
                          disabled={imapSaving || !imapEmail || !imapPass || !imapHost}
                          className="flex-1 bg-charcoal text-white rounded-xl py-2.5 text-sm font-medium hover:bg-black transition-colors disabled:opacity-50 shadow-sm active-press touch-target"
                        >
                          {imapSaving ? "Yhdistetään..." : "Yhdistä"}
                        </button>
                      </div>

                      {imapMsg && <p className="text-xs text-danger">{imapMsg}</p>}
                    </form>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmModal
        isOpen={accountToDisconnect !== null}
        title="Katkaise yhteys?"
        description="Oletko varma, että haluat katkaista yhteyden tähän sähköpostitiliin? Tulevia kuitteja ei enää tuoda automaattisesti."
        confirmLabel="Katkaise yhteys"
        onConfirm={async () => {
          if (!accountToDisconnect) return;
          const id = accountToDisconnect;
          try {
            const res = await fetch(`/api/integrations/imap?id=${id}`, { method: "DELETE" });
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
    </>
  );
}
