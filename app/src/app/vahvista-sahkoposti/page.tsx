"use client";

import { Suspense, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CircleCheck, Link2Off } from "lucide-react";
import { BARE_CARD_CLASS, BARE_LINK_CLASS, BareCardSkeleton, BareFrame } from "@/components/BareFrame";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { buttonClass } from "@/components/control-styles";
import { NoticeCard } from "@/components/ScreenState";
import { Icon } from "@/components/ds/Icon";
import { Button } from "@/components/ui";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { hapticNotify } from "@/lib/haptics";

const noSubscribe = () => () => {};
/** See palauta-salasana: iPhone browser outside the bundled app, read without a hydration mismatch. */
function useMailBrowserOnIos(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => !IS_MOBILE_BUILD && /iPhone|iPad/.test(navigator.userAgent),
    () => false
  );
}

function ConfirmForm({ token }: { token: string }) {
  const openApp = useMailBrowserOnIos();
  const [confirmedEmail, setConfirmedEmail] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch("/api/auth/email/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await readJson<{ email?: string }>(response, "Vahvistus epäonnistui");
      void hapticNotify("success");
      setConfirmedEmail(body.email ?? "");
    } catch (caught: unknown) {
      void hapticNotify("error");
      setError(errorMessage(caught, "Vahvistus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  if (confirmedEmail !== null) {
    return (
      <div className={BARE_CARD_CLASS}>
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10 text-success">
          <Icon icon={CircleCheck} size="hero" />
        </span>
        <h1 className="text-title-2 font-bold leading-tight tracking-[-0.02em] text-ink">Sähköposti vaihdettu</h1>
        <p className="text-body leading-relaxed text-ink-2" role="status">
          {confirmedEmail
            ? `Kirjaudu jatkossa osoitteella ${confirmedEmail}.`
            : "Kirjaudu jatkossa uudella osoitteella."}
        </p>
        <Link href="/login" className={buttonClass("primary", "w-full")}>
          Kirjaudu sisään
        </Link>
        {openApp && (
          <a href="lashkirja://open" className={BARE_LINK_CLASS}>
            Avaa LashKirja-sovellus
          </a>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} className={BARE_CARD_CLASS}>
      <h1 className="text-title-2 font-bold leading-tight tracking-[-0.02em] text-ink">Vahvista sähköposti</h1>
      <p className="text-body leading-relaxed text-ink-2">
        Vahvistus vaihtaa kirjautumissähköpostin. Vanha osoite toimii, kunnes painat nappia.
      </p>
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" busy={busy} busyLabel="Vahvistetaan…" className="w-full">
        Vahvista
      </Button>
      <Link href="/asetukset/profiili" className={BARE_LINK_CLASS}>
        Profiiliin
      </Link>
    </form>
  );
}

function TokenMissing() {
  return (
    <NoticeCard
      icon={Link2Off}
      tone="warning"
      title="Linkki ei kelpaa"
      body="Vahvistuslinkki puuttuu tai on vanhentunut. Pyydä uusi vahvistus profiilistasi."
    >
      <Link href="/asetukset/profiili" className={buttonClass("primary", "mt-5 w-full")}>
        Avaa profiili
      </Link>
    </NoticeCard>
  );
}

function ConfirmGate() {
  const token = useSearchParams().get("token") || "";
  return token ? <ConfirmForm token={token} /> : <TokenMissing />;
}

export default function ConfirmEmailPage() {
  return (
    <BareFrame>
      <Suspense fallback={<BareCardSkeleton />}>
        <ConfirmGate />
      </Suspense>
    </BareFrame>
  );
}
