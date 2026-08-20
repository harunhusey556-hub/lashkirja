"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import ConfirmModal from "@/components/ConfirmModal";
import { SelectMenu } from "@/components/SelectMenu";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import {
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";

import SellerProfileCard from "@/components/SellerProfileCard";
interface Profile {
  firstName: string;
  lastName: string;
  email: string;
  entityType: string;
  vatRegistered: boolean;
  vatPeriod: string;
  imapAccounts: { id: string; email: string }[];
}

type ProviderType = 'gmail' | 'outlook' | 'icloud' | 'other' | null;

export default function AsetuksetPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Profile Edit State
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editFirstName, setEditFirstName] = useState("");
  const [editLastName, setEditLastName] = useState("");
  const [editEmail, setEditEmail] = useState("");

  // IMAP Connect State
  const [isAddingEmail, setIsAddingEmail] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<ProviderType>(null);
  const [imapEmail, setImapEmail] = useState("");
  const [imapPass, setImapPass] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapSaving, setImapSaving] = useState(false);
  const [imapMsg, setImapMsg] = useState("");
  const [accountToDisconnect, setAccountToDisconnect] = useState<string | null>(null);

  // Sync State
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/profile", { signal: controller.signal })
      .then((response) =>
        readJson<{ profile: Profile }>(
          response,
          "Asetusten lataus epäonnistui"
        )
      )
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!data.profile) {
          throw new Error("Palvelin palautti virheelliset asetukset");
        }
        setLoadError("");
        setProfile(data.profile);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setLoadError(errorMessage(error, "Asetusten lataus epäonnistui"));
      });
    return () => controller.abort();
  }, [loadAttempt]);

  async function save(update: Partial<Profile>) {
    if (!profile || saving) return;
    const previous = profile;
    const next = { ...profile, ...update };
    setProfile(next);
    setSaving(true);
    setSavedMsg("");
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      const data = await readJson<{
        profile: Partial<Profile>;
      }>(res, "Tallennus epäonnistui");
      setProfile((current) =>
        current ? { ...current, ...data.profile } : current
      );
      setSavedMsg("Tallennettu");
      setIsEditingProfile(false);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setProfile(previous);
      setSavedMsg(errorMessage(error, "Tallennus epäonnistui"));
    } finally {
      setSaving(false);
      setTimeout(() => setSavedMsg(""), 3000);
    }
  }

  async function handleEmergencySync() {
    if (syncing) return;
    setSyncing(true);
    setSyncMsg("Etsitään kuitteja...");
    try {
      const res = await fetch("/api/integrations/imap/sync", {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Synkronointi epäonnistui");
      setSyncMsg(`Synkronoitu onnistuneesti! Löydettiin ${data.count} uutta kuittia.`);
    } catch (err: any) {
      setSyncMsg(err.message);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(""), 6000);
    }
  }

  const renderProviderInstructions = () => {
    switch (selectedProvider) {
      case 'gmail':
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
      case 'outlook':
        return (
          <div className="bg-cream/50 p-4 rounded-xl border border-warm-gray-light text-sm text-charcoal space-y-2">
            <p className="font-medium">Näin luot Microsoft-sovellussalasanan:</p>
            <ol className="list-decimal pl-4 space-y-1 text-warm-gray">
              <li>Mene <b>Microsoft-tilin turva-asetuksiin</b>.</li>
              <li>Valitse <b>Lisäsuojausasetukset</b> (Advanced security options).</li>
              <li>Varmista, että kaksivaiheinen todennus on käytössä.</li>
              <li>Valitse "Luo uusi sovellussalasana" (Create a new app password).</li>
            </ol>
          </div>
        );
      case 'icloud':
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
    if (provider === 'gmail') {
      setImapHost("imap.gmail.com");
      setImapPort("993");
    } else if (provider === 'outlook') {
      setImapHost("outlook.office365.com");
      setImapPort("993");
    } else if (provider === 'icloud') {
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
      <AppShell>
        <ErrorState
          message={loadError}
          onRetry={() => {
            setLoadError("");
            setLoadAttempt((attempt) => attempt + 1);
          }}
        />
      </AppShell>
    );
  }

  if (!profile) {
    return (
      <AppShell>
        <LoadingState label="Ladataan asetuksia..." />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <h2 className="text-xl font-light text-charcoal">Asetukset</h2>

        <div className="bg-white rounded-2xl p-6 shadow-sm">
          <div className="flex justify-between items-start">
            {isEditingProfile ? (
              <form 
                className="w-full space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  save({
                    firstName: editFirstName,
                    lastName: editLastName,
                    email: editEmail,
                  });
                }}
              >
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-charcoal-light mb-1">Etunimi</label>
                    <input 
                      type="text" 
                      required
                      value={editFirstName}
                      onChange={e => setEditFirstName(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-charcoal-light mb-1">Sukunimi</label>
                    <input 
                      type="text" 
                      required
                      value={editLastName}
                      onChange={e => setEditLastName(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-charcoal-light mb-1">Sähköposti</label>
                  <input 
                    type="email" 
                    required
                    value={editEmail}
                    onChange={e => setEditEmail(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => setIsEditingProfile(false)}
                    className="px-4 py-2 rounded-xl border border-warm-gray-light text-sm text-charcoal hover:bg-cream"
                  >
                    Peruuta
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 rounded-xl bg-accent text-white text-sm hover:bg-accent-dark disabled:opacity-50"
                  >
                    Tallenna
                  </button>
                </div>
              </form>
            ) : (
              <>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-charcoal">
                    {profile.firstName} {profile.lastName}
                  </p>
                  <p className="text-xs text-warm-gray">{profile.email}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditFirstName(profile.firstName);
                    setEditLastName(profile.lastName);
                    setEditEmail(profile.email);
                    setIsEditingProfile(true);
                  }}
                  className="text-xs text-accent hover:underline font-medium"
                >
                  Muokkaa
                </button>
              </>
            )}
          </div>
        </div>

        <div className="bg-white rounded-2xl p-6 shadow-sm space-y-5">
          <div>
            <label className="block text-sm font-medium text-charcoal-light mb-2">
              Yritysmuoto
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => save({ entityType: "kevytyrittaja" })}
                disabled={saving}
                aria-pressed={profile.entityType === "kevytyrittaja"}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                  profile.entityType === "kevytyrittaja"
                    ? "bg-accent text-white"
                    : "bg-cream text-charcoal border border-warm-gray-light"
                }`}
              >
                Kevytyrittäjä
              </button>
              <button
                type="button"
                onClick={() => save({ entityType: "toiminimi" })}
                disabled={saving}
                aria-pressed={profile.entityType === "toiminimi"}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                  profile.entityType === "toiminimi"
                    ? "bg-accent text-white"
                    : "bg-cream text-charcoal border border-warm-gray-light"
                }`}
              >
                Toiminimi
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-charcoal-light">
                ALV-rekisterissä
              </p>
              <p className="text-xs text-warm-gray mt-0.5">
                Raja 20 000 € / kalenterivuosi
              </p>
            </div>
            <button
              type="button"
              onClick={() => save({ vatRegistered: !profile.vatRegistered })}
              disabled={saving}
              role="switch"
              aria-checked={profile.vatRegistered}
              aria-label="ALV-rekisterissä"
              className={`w-12 h-7 rounded-full transition-colors relative ${
                profile.vatRegistered ? "bg-accent" : "bg-warm-gray-light"
              }`}
            >
              <span
                className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow transition-all ${
                  profile.vatRegistered ? "left-6" : "left-1"
                }`}
              />
            </button>
          </div>

          {profile.vatRegistered && (
            <div>
              <SelectMenu
                id="vat-period"
                label="ALV-verokausi"
                value={profile.vatPeriod}
                disabled={saving}
                options={[
                  { value: "month", label: "Kuukausi", description: "OmaVero-ilmoitus kuukausittain (oletus)" },
                  { value: "quarter", label: "Neljännesvuosi", description: "OmaVero-ilmoitus 3kk välein" },
                  { value: "year", label: "Kalenterivuosi", description: "OmaVero-ilmoitus kerran vuodessa" },
                ]}
                onChange={(newVal) => save({ vatPeriod: newVal })}
              />
            </div>
          )}

          {(saving || savedMsg) && (
            <p
              className={`text-xs ${savedMsg && savedMsg !== "Tallennettu" ? "text-danger" : "text-success"}`}
              role={savedMsg && savedMsg !== "Tallennettu" ? "alert" : "status"}
              aria-live="polite"
            >
              {saving ? "Tallennetaan..." : savedMsg}
            </p>
          )}
        </div>

        <SellerProfileCard />

        <div className="bg-white rounded-2xl p-6 shadow-sm space-y-6">
          {/* Stacks on phones — shrink-0 next to the description overflowed the
              viewport at 320px. Side by side from sm up. */}
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
                className="shrink-0 self-start px-4 py-2 rounded-xl bg-charcoal text-white text-xs font-medium hover:bg-black transition-colors shadow-sm disabled:opacity-50"
              >
                {syncing ? "Synkronoidaan..." : "Synkronoi kuitit nyt"}
              </button>
            )}
          </div>

          {syncMsg && (
            <div className={`p-3 rounded-xl text-sm ${syncMsg.includes('epäonnistui') ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success-dark'}`}>
              {syncMsg}
            </div>
          )}

          {profile.imapAccounts.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-charcoal-light">Yhdistetyt tilit</h4>
              {profile.imapAccounts.map((account) => (
                <div key={account.id} className="rounded-xl border border-success/30 bg-success/5 p-4 flex justify-between items-center">
                  <div>
                    <p className="text-sm font-medium text-success-dark">Aktiivinen</p>
                    <p className="text-xs text-charcoal mt-0.5">{account.email}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAccountToDisconnect(account.id)}
                    className="text-xs font-medium text-danger hover:underline"
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
                className="w-full py-3 rounded-xl border border-warm-gray-light border-dashed text-sm font-medium text-charcoal hover:bg-cream transition-colors flex items-center justify-center gap-2"
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
                      className="text-xs font-medium text-warm-gray hover:text-charcoal transition-colors"
                    >
                      Peruuta
                    </button>
                  )}
                </div>

                {!selectedProvider ? (
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => handleProviderSelect('gmail')}
                      className="flex flex-col items-center justify-center p-4 rounded-xl border border-warm-gray-light hover:border-accent hover:bg-cream transition-all group"
                    >
                      <span className="text-sm font-medium text-charcoal group-hover:text-accent">Gmail</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleProviderSelect('outlook')}
                      className="flex flex-col items-center justify-center p-4 rounded-xl border border-warm-gray-light hover:border-accent hover:bg-cream transition-all group"
                    >
                      <span className="text-sm font-medium text-charcoal group-hover:text-accent">Outlook / Hotmail</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleProviderSelect('icloud')}
                      className="flex flex-col items-center justify-center p-4 rounded-xl border border-warm-gray-light hover:border-accent hover:bg-cream transition-all group"
                    >
                      <span className="text-sm font-medium text-charcoal group-hover:text-accent">iCloud</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleProviderSelect('other')}
                      className="flex flex-col items-center justify-center p-4 rounded-xl border border-warm-gray-light hover:border-accent hover:bg-cream transition-all group"
                    >
                      <span className="text-sm font-medium text-charcoal group-hover:text-accent">Muu IMAP</span>
                    </button>
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
                            })
                          });
                          const json = await res.json();
                          if (!res.ok) throw new Error(json.error || "Yhdistäminen epäonnistui");
                          setProfile({
                            ...profile,
                            imapAccounts: [...profile.imapAccounts, { id: Math.random().toString(), email: json.email }]
                          });
                          cancelAdding();
                        } catch (err: any) {
                          setImapMsg(err.message);
                        } finally {
                          setImapSaving(false);
                        }
                      }}
                      className="space-y-4"
                    >
                      {selectedProvider === 'other' && (
                        <div className="grid grid-cols-[1fr_100px] gap-3">
                          <div>
                            <label className="block text-xs font-medium text-charcoal-light mb-1">
                              IMAP Palvelin
                            </label>
                            <input 
                              type="text" 
                              placeholder="esim. imap.omaverkko.fi"
                              value={imapHost}
                              onChange={e => setImapHost(e.target.value)}
                              className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                              required
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-charcoal-light mb-1">
                              Portti
                            </label>
                            <input 
                              type="number" 
                              value={imapPort}
                              onChange={e => setImapPort(e.target.value)}
                              className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                              required
                            />
                          </div>
                        </div>
                      )}

                      <div>
                        <label className="block text-xs font-medium text-charcoal-light mb-1">
                          Sähköpostiosoite
                        </label>
                        <input 
                          type="email" 
                          value={imapEmail}
                          onChange={e => setImapEmail(e.target.value)}
                          className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-charcoal-light mb-1">
                          Sovellussalasana
                        </label>
                        <input 
                          type="password" 
                          value={imapPass}
                          onChange={e => setImapPass(e.target.value)}
                          className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                          required
                        />
                      </div>
                      
                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={() => setSelectedProvider(null)}
                          className="px-4 py-2.5 rounded-xl border border-warm-gray-light text-sm font-medium text-charcoal hover:bg-cream transition-colors"
                        >
                          Takaisin
                        </button>
                        <button
                          type="submit"
                          disabled={imapSaving || !imapEmail || !imapPass || !imapHost}
                          className="flex-1 bg-charcoal text-white rounded-xl py-2.5 text-sm font-medium hover:bg-black transition-colors disabled:opacity-50 shadow-sm"
                        >
                          {imapSaving ? "Yhdistetään..." : "Yhdistä"}
                        </button>
                      </div>
                      
                      {imapMsg && (
                        <p className="text-xs text-danger">{imapMsg}</p>
                      )}
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
          setAccountToDisconnect(null);
          await fetch(`/api/integrations/imap?id=${id}`, { method: "DELETE" });
          setProfile({
            ...profile,
            imapAccounts: profile.imapAccounts.filter(a => a.id !== id)
          });
        }}
        onCancel={() => setAccountToDisconnect(null)}
      />
    </AppShell>
  );
}
