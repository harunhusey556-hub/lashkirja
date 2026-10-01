"use client";

import { useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import { ExternalLink } from "@/components/ExternalLink";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { type Profile, useProfile } from "../useProfile";
import { ProfileGate } from "../ProfileGate";
import { Plus } from "lucide-react";
import { Card, Icon, PageTitle } from "@/components/ds";
import { PasswordField } from "@/components/ds/PasswordField";
import { controlClass, tintedButtonClass } from "@/components/control-styles";
import { Button, Field, FormError } from "@/components/ui";
import { hapticNotify } from "@/lib/haptics";
import { showToast } from "@/lib/toast";

type ProviderType = "gmail" | "outlook" | "icloud" | "other" | null;

/** A numbered "how to make an app password" card with a real link to the provider's page. */
function ProviderSteps({
  title,
  link,
  steps,
}: {
  title: string;
  link: { href: string; label: string };
  steps: React.ReactNode[];
}) {
  return (
    <div className="space-y-2 rounded-card border border-line bg-canvas p-4 text-caption text-ink">
      <p className="font-medium">{title}</p>
      <ol className="list-decimal space-y-1 pl-4 text-ink-2">
        {steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
      <ExternalLink href={link.href} className="text-body">
        {link.label}
      </ExternalLink>
    </div>
  );
}

export default function SahkopostiPage() {
  const { profile, setProfile, loadError, retry, reload } = useProfile();

  return (
    <ProfileGate
      profile={profile}
      loadError={loadError}
      retry={retry}
      title="Sähköpostien tuonti"
      skeletonLabel="Ladataan asetuksia"
      fields={3}
    >
      {(loaded) => (
        <>
          <PageTitle title="Sähköpostien tuonti" />
          <ImapCard profile={loaded} setProfile={setProfile} reload={reload} retry={retry} />
        </>
      )}
    </ProfileGate>
  );
}

function ImapCard({
  profile,
  setProfile,
  reload,
  retry,
}: {
  profile: Profile;
  setProfile: (profile: Profile) => void;
  reload: () => Promise<boolean>;
  retry: () => void;
}) {
  const [isAddingEmail, setIsAddingEmail] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<ProviderType>(null);
  const [imapEmail, setImapEmail] = useState("");
  const [imapPass, setImapPass] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapSaving, setImapSaving] = useState(false);
  const [imapError, setImapError] = useState("");
  const [accountToDisconnect, setAccountToDisconnect] = useState<string | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function handleSync() {
    if (syncing) return;
    setSyncing(true);
    setSyncNote({ tone: "success", text: "Etsitään kuitteja…" });
    try {
      const res = await apiFetch("/api/integrations/imap/sync", { method: "POST" });
      const data = await readJson<{ count: number }>(res, "Synkronointi epäonnistui");
      setSyncNote({ tone: "success", text: `Synkronointi valmis. Löytyi ${data.count} uutta kuittia.` });
      void hapticNotify("success");
    } catch (err: unknown) {
      setSyncNote({ tone: "error", text: errorMessage(err, "Synkronointi epäonnistui") });
      void hapticNotify("error");
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncNote(null), 6000);
    }
  }

  const renderProviderInstructions = () => {
    switch (selectedProvider) {
      case "gmail":
        return (
          <ProviderSteps
            title="Näin luot Google-sovellussalasanan:"
            link={{ href: "https://myaccount.google.com/apppasswords", label: "Avaa Google-tilin sovellussalasanat" }}
            steps={[
              <>Avaa <b>Google-tilin asetukset</b>. Varmista, että 2-vaiheinen vahvistus on päällä.</>,
              <>Hae asetuksista <b>Sovellussalasanat</b> ja luo uusi.</>,
              <>Kopioi 16-kirjaiminen koodi alle.</>,
            ]}
          />
        );
      case "outlook":
        return (
          <ProviderSteps
            title="Näin luot Microsoft-sovellussalasanan:"
            link={{ href: "https://account.microsoft.com/security", label: "Avaa Microsoft-tilin turva-asetukset" }}
            steps={[
              <>Valitse <b>Lisäsuojausasetukset</b>.</>,
              <>Varmista, että kaksivaiheinen todennus on käytössä.</>,
              <>Valitse &quot;Luo uusi sovellussalasana&quot; ja kopioi se alle.</>,
            ]}
          />
        );
      case "icloud":
        return (
          <ProviderSteps
            title="Näin luot Apple-sovellussalasanan:"
            link={{ href: "https://appleid.apple.com", label: "Avaa Apple-tilin sivu" }}
            steps={[
              <>Kirjaudu sisään ja avaa <b>Sisäänkirjautuminen ja suojaus</b>.</>,
              <>Valitse <b>Appikohtaiset salasanat</b>.</>,
              <>Luo uusi salasana sovellukselle ja kopioi se alle.</>,
            ]}
          />
        );
      default:
        return (
          <p className="text-caption text-ink-2">
            Täytä saapuvan postin palvelimen tiedot ja sovellussalasana. Löydät palvelimen tiedot sähköpostin tarjoajalta.
          </p>
        );
    }
  };

  const handleProviderSelect = (provider: ProviderType) => {
    setSelectedProvider(provider);
    setImapError("");
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
    setImapError("");
    setImapEmail("");
    setImapPass("");
  };

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    if (imapSaving) return;
    setImapSaving(true);
    setImapError("");
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
      const json = await readJson<{ email: string }>(res, "Yhdistäminen epäonnistui");
      // AUTH-15: the server answers with the address only, so the new row's id
      // comes from the profile itself. A made-up id would make "Katkaise
      // yhteys" delete something that does not exist.
      const refreshed = await reload();
      if (!refreshed) retry();
      showToast({ tone: "success", text: `Sähköposti ${json.email} yhdistetty.` });
      cancelAdding();
    } catch (err: unknown) {
      void hapticNotify("error");
      setImapError(errorMessage(err, "Yhdistäminen epäonnistui"));
    } finally {
      setImapSaving(false);
    }
  }

  const canConnect = Boolean(imapEmail && imapPass && imapHost);

  return (
    <>
      <Card className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-body font-medium text-ink">Sähköpostiautomaatio</h2>
            <p className="mt-1 text-caption text-ink-2">
              Yhdistä sähköpostiosoitteesi, niin sovellus hakee ja analysoi automaattisesti siihen saapuneet kuitit.
            </p>
          </div>
          {profile.imapAccounts.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              className="shrink-0 self-start"
              onClick={() => void handleSync()}
              busy={syncing}
              busyLabel="Synkronoidaan…"
            >
              Synkronoi kuitit nyt
            </Button>
          )}
        </div>

        {syncNote && (
          <div
            role={syncNote.tone === "error" ? "alert" : "status"}
            className={`rounded-card p-3 text-caption ${
              syncNote.tone === "error" ? "bg-danger/10 text-danger" : "bg-success/10 text-success"
            }`}
          >
            {syncNote.text}
          </div>
        )}

        {profile.imapAccounts.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-caption text-ink-2">Yhdistetyt tilit</h3>
            {profile.imapAccounts.map((account) => (
              <div
                key={account.id}
                className="flex items-center justify-between gap-3 rounded-card border border-success/30 bg-success/5 p-4"
              >
                <div className="min-w-0">
                  <p className="text-caption font-medium text-success">Aktiivinen</p>
                  <p className="mt-0.5 clamp-lines [overflow-wrap:anywhere] text-caption text-ink">{account.email}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setAccountToDisconnect(account.id)}
                  className={tintedButtonClass("danger", "shrink-0")}
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
              className="active-press touch-target flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-line py-3 text-body font-medium text-ink"
            >
              <Icon icon={Plus} size="inline" />
              Lisää toinen sähköpostitili
            </button>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h3 className="text-caption text-ink-2">
                  {profile.imapAccounts.length > 0 ? "Lisää uusi sähköpostitili" : "Yhdistä sähköpostitili"}
                </h3>
                {profile.imapAccounts.length > 0 && (
                  <button
                    type="button"
                    onClick={cancelAdding}
                    className={tintedButtonClass("neutral")}
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
                      ["other", "Muu sähköposti"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => handleProviderSelect(value)}
                      className="active-press touch-target flex flex-col items-center justify-center rounded-card border border-line p-4"
                    >
                      <span className="text-body font-medium text-ink">{label}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-5">
                  {renderProviderInstructions()}

                  <form onSubmit={(event) => void connect(event)} className="space-y-4">
                    {selectedProvider === "other" && (
                      <div className="grid grid-cols-[1fr_100px] gap-3">
                        <Field label="Saapuvan postin palvelin" htmlFor="imapHost">
                          <input
                            id="imapHost"
                            name="imapHost"
                            type="text"
                            inputMode="url"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            enterKeyHint="next"
                            placeholder="esim. imap.omaverkko.fi"
                            value={imapHost}
                            onChange={(e) => setImapHost(e.target.value)}
                            className={controlClass}
                            required
                          />
                        </Field>
                        <Field label="Portti" htmlFor="imapPort">
                          <input
                            id="imapPort"
                            name="imapPort"
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            maxLength={5}
                            enterKeyHint="next"
                            value={imapPort}
                            onChange={(e) => setImapPort(e.target.value.replace(/\D/g, ""))}
                            className={controlClass}
                            required
                          />
                        </Field>
                      </div>
                    )}

                    <Field label="Sähköpostiosoite" htmlFor="imapEmail">
                      <input
                        id="imapEmail"
                        name="imapEmail"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        enterKeyHint="next"
                        value={imapEmail}
                        onChange={(e) => setImapEmail(e.target.value)}
                        className={controlClass}
                        required
                      />
                    </Field>
                    <PasswordField
                      id="imapPass"
                      name="imapPass"
                      label="Sovellussalasana"
                      autoComplete="off"
                      enterKeyHint="go"
                      value={imapPass}
                      onChange={(e) => setImapPass(e.target.value)}
                      required
                    />

                    <div className="flex gap-3">
                      <Button type="button" variant="secondary" onClick={() => setSelectedProvider(null)}>
                        Takaisin
                      </Button>
                      <Button
                        type="submit"
                        className="flex-1"
                        disabled={!canConnect}
                        disabledReason={!canConnect ? "Täytä sähköposti, salasana ja palvelin." : undefined}
                        busy={imapSaving}
                        busyLabel="Yhdistetään ja testataan…"
                      >
                        Yhdistä
                      </Button>
                    </div>
                    <FormError message={imapError} />
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
          const res = await apiFetch(`/api/integrations/imap?id=${encodeURIComponent(id)}`, { method: "DELETE" });
          if (!res.ok) throw new Error("Yhteyden katkaisu epäonnistui. Yritä uudelleen.");
          setProfile({
            ...profile,
            imapAccounts: profile.imapAccounts.filter((a) => a.id !== id),
          });
          setAccountToDisconnect(null);
        }}
        onCancel={() => setAccountToDisconnect(null)}
      />
    </>
  );
}
