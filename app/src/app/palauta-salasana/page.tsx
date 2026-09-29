"use client";

import { Suspense, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CircleCheck, Link2Off } from "lucide-react";
import { BARE_CARD_CLASS, BARE_LINK_CLASS, BareFrame } from "@/components/BareFrame";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { Icon } from "@/components/ds/Icon";
import { PasswordField } from "@/components/ds/PasswordField";
import { buttonClass } from "@/components/control-styles";
import { Button } from "@/components/ui";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { hapticNotify } from "@/lib/haptics";
import { PASSWORD_MIN as MIN_PASSWORD_LENGTH } from "@/lib/session-policy";


const noSubscribe = () => () => {};
/** True in an iPhone/iPad browser outside the bundled app, where the reset
 * link was opened from a mail. Read through useSyncExternalStore so the
 * server render and hydration agree (AUTH-23). */
function useMailBrowserOnIos(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => !IS_MOBILE_BUILD && /iPhone|iPad/.test(navigator.userAgent),
    () => false
  );
}

function TokenMissing() {
  return (
    <div className={BARE_CARD_CLASS}>
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-warning/10 text-warning">
        <Icon icon={Link2Off} size="hero" />
      </span>
      <h1 className="text-title-2 font-bold leading-tight tracking-[-0.02em] text-ink">Linkki ei kelpaa</h1>
      <p className="text-body leading-relaxed text-ink-2" role="alert">
        Linkki puuttuu tai on vanhentunut. Pyydä uusi palautuslinkki.
      </p>
      <Link href="/unohtunut-salasana" className={buttonClass("primary", "w-full")}>
        Pyydä uusi linkki
      </Link>
      <Link href="/login" className={BARE_LINK_CLASS}>
        Kirjaudu sisään
      </Link>
    </div>
  );
}

function ResetForm({ token }: { token: string }) {
  const openApp = useMailBrowserOnIos();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<{ password?: string; repeat?: string; form?: string }>({});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const next: typeof errors = {};
    if (password.length < MIN_PASSWORD_LENGTH) {
      next.password = `Salasanassa on oltava vähintään ${MIN_PASSWORD_LENGTH} merkkiä.`;
    }
    if (repeat !== password) next.repeat = "Salasanat eivät täsmää.";
    setErrors(next);
    if (next.password || next.repeat) {
      void hapticNotify("error");
      document.getElementById(next.password ? "password" : "repeatPassword")?.focus();
      return;
    }
    setBusy(true);
    try {
      const response = await apiFetch("/api/auth/password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token, password }),
      });
      await readJson(response, "Salasanan vaihto epäonnistui");
      void hapticNotify("success");
      setPassword("");
      setRepeat("");
      setDone(true);
    } catch (caught: unknown) {
      void hapticNotify("error");
      setErrors({ form: errorMessage(caught, "Salasanan vaihto epäonnistui") });
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className={BARE_CARD_CLASS}>
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10 text-success">
          <Icon icon={CircleCheck} size="hero" />
        </span>
        <h1 className="text-title-2 font-bold leading-tight tracking-[-0.02em] text-ink">Salasana vaihdettu</h1>
        <p className="text-body leading-relaxed text-ink-2" role="status">
          Voit nyt kirjautua sisään uudella salasanalla.
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
    <form onSubmit={(event) => void submit(event)} noValidate className={BARE_CARD_CLASS}>
      <h1 className="text-title-2 font-bold leading-tight tracking-[-0.02em] text-ink">Uusi salasana</h1>
      <PasswordField
        id="password"
        name="password"
        label="Uusi salasana"
        autoComplete="new-password"
        enterKeyHint="next"
        hint={`Vähintään ${MIN_PASSWORD_LENGTH} merkkiä.`}
        error={errors.password}
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <PasswordField
        id="repeatPassword"
        name="repeatPassword"
        label="Toista uusi salasana"
        autoComplete="new-password"
        enterKeyHint="go"
        error={errors.repeat}
        required
        value={repeat}
        onChange={(event) => setRepeat(event.target.value)}
      />
      {errors.form && (
        <p className="text-sm text-danger" role="alert">
          {errors.form}{" "}
          <Link href="/unohtunut-salasana" className="font-medium underline">
            Pyydä uusi linkki
          </Link>
        </p>
      )}
      <Button type="submit" busy={busy} busyLabel="Tallennetaan…" className="w-full">
        Tallenna salasana
      </Button>
      <Link href="/login" className={BARE_LINK_CLASS}>
        Kirjaudu sisään
      </Link>
    </form>
  );
}

function ResetGate() {
  const token = useSearchParams().get("token") || "";
  return token ? <ResetForm token={token} /> : <TokenMissing />;
}

export default function ResetPasswordPage() {
  return (
    <BareFrame>
      <Suspense fallback={<p className="text-center text-sm text-ink-2">Ladataan…</p>}>
        <ResetGate />
      </Suspense>
    </BareFrame>
  );
}
