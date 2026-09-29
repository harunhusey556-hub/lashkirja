"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Check, Info } from "lucide-react";
import { controlClass } from "@/components/control-styles";
import { AppMark } from "@/components/AppMark";
import { BareFrame } from "@/components/BareFrame";
import { ConnectivityBanner } from "@/components/ConnectivityBanner";
import { ApiError, errorMessage } from "@/components/clientFetch";
import { Button, Field } from "@/components/ui";
import { Icon } from "@/components/ds/Icon";
import { PasswordField } from "@/components/ds/PasswordField";
import { hapticNotify } from "@/lib/haptics";
import { appNavigate } from "@/lib/app-nav";
import { getAccessToken, signIn } from "@/lib/auth-client";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { bootMobile } from "@/lib/mobile/boot";
import { markFirstScreen } from "@/lib/splash";

const SHOW_DEMO_LOGIN = !IS_MOBILE_BUILD && process.env.NEXT_PUBLIC_SHOW_DEMO_LOGIN === "true";

type Tone = "danger" | "info";
type Notice = { tone: Tone; message: string } | null;

// Shown on load from `?error=<code>` - a redirect from the server (the no-JS
// form-POST fallback, or a link that bounced here, e.g. an expired session).
// `tone` carries severity explicitly rather than it being guessed from the
// text: an expired session is informational, everything else is a hard stop.
const INITIAL_NOTICES: Record<string, { message: string; tone: Tone }> = {
  auth: {
    message: "Sähköposti tai salasana on väärin. Tarkista ja yritä uudelleen.",
    tone: "danger",
  },
  missing: { message: "Sähköposti ja salasana vaaditaan", tone: "danger" },
  server: { message: "Kirjautuminen epäonnistui", tone: "danger" },
  rate: {
    message: "Liian monta kirjautumisyritystä. Yritä muutaman minuutin kuluttua uudelleen.",
    tone: "danger",
  },
  expired: { message: "Istuntosi vanhentui. Kirjaudu sisään uudelleen.", tone: "info" },
  closed: {
    message: "Tilin käyttö on suljettu. Kirjanpitoaineisto säilyy säilytysajan.",
    tone: "danger",
  },
};

function formatRetryAfter(seconds: number): string {
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} minuutin`;
  }
  return `${Math.max(1, seconds)} sekunnin`;
}

function LoginNotice({ id, tone, message }: { id: string; tone: Tone; message: string }) {
  return (
    <div
      id={id}
      role={tone === "danger" ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-card border p-3 text-left text-sm ${
        tone === "danger" ? "border-danger/30 bg-danger/10 text-danger" : "border-warning/40 bg-warning/10 text-ink"
      }`}
    >
      <Icon
        icon={tone === "danger" ? AlertCircle : Info}
        size="row"
        className={`mt-0.5 shrink-0 ${tone === "danger" ? "text-danger" : "text-warning"}`}
      />
      <p>{message}</p>
    </div>
  );
}

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // A ref, not state: must be readable synchronously inside handleSubmit to
  // block a second submit fired before the next render (Enter key repeat,
  // a second click landing before React re-renders the disabled button).
  const submittingRef = useRef(false);

  // Lazy initializers, not a mount effect: `?error=` is already present in
  // the very first render (a server redirect landed here), so deriving the
  // initial notice belongs in useState's initializer, not in a setState call
  // inside a useEffect body (which would just be an avoidable second render).
  const [phase, setPhase] = useState<"idle" | "submitting" | "success">("idle");
  const [notice, setNotice] = useState<Notice>(() => {
    const errorCode = searchParams.get("error");
    if (!errorCode) return null;
    return INITIAL_NOTICES[errorCode] ?? { tone: "danger", message: "Kirjautuminen epäonnistui" };
  });
  // Only the "auth" redirect code corresponds to actually-wrong credentials;
  // the others (missing/server/rate/expired/closed) do not mark the fields.
  const [invalid, setInvalid] = useState(() => searchParams.get("error") === "auth");
  const [shake, setShake] = useState(false);

  // Deep-link continue-after-login: the server already validated this is an
  // internal path when it built the /login?next= redirect; carried through
  // so the login POST can send it straight back.
  const next = searchParams.get("next") || "";

  // iOS bfcache: swiping back to the login page restores the old React state,
  // which would leave the button stuck on the spinner - reset it on pageshow.
  useEffect(() => {
    const reset = () => {
      submittingRef.current = false;
      setPhase("idle");
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  // Mobile only (Task 7): LoginForm is one of the two possible "first real
  // screen"s (the other is AppShell's children) -- hides the native splash
  // once this form has actually painted, two rAFs after mount, same as
  // AppShell's own timing. Idempotent: harmless if the redirect below fires
  // moments later and AppShell's own call runs too.
  useEffect(() => {
    if (!IS_MOBILE_BUILD) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => markFirstScreen());
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  // Mobile only: a signed-in user who lands on /login (navigating back in
  // the SPA after signing in, or reloading directly on /login) is bounced
  // straight to /dashboard instead of being shown the form again.
  // bootMobile() is awaited (not a plain getAccessToken() read) so this
  // also catches a fresh page load, where nothing has loaded the Keychain
  // token into memory yet.
  useEffect(() => {
    if (!IS_MOBILE_BUILD) return;
    let cancelled = false;
    // bootMobile() is only a barrier here. Its resolved verdict is memoized for
    // the whole launch, so after a sign-out it still says "signed in" and
    // would bounce the person straight back into the app: the live token is
    // read after the barrier instead (same rule as SessionProvider).
    void bootMobile().then(() => {
      if (!cancelled && getAccessToken()) appNavigate("/dashboard", { replace: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function clearNoticeOnEdit() {
    if (!notice && !invalid) return;
    setNotice(null);
    setInvalid(false);
  }

  function triggerShake() {
    // Force the animation to restart even if a previous shake is still
    // playing (rapid repeated wrong attempts): drop the class, then re-add
    // it on the next frame rather than relying on a same-value state set.
    setShake(false);
    requestAnimationFrame(() => setShake(true));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setPhase("submitting");
    setNotice(null);
    setInvalid(false);

    const email = emailRef.current?.value.trim() ?? "";
    const password = passwordRef.current?.value ?? "";

    try {
      const result = await signIn({ email, password, next });

      if (result.ok) {
        void hapticNotify("success");
        setPhase("success");
        router.push(next || "/dashboard");
        return;
      }

      submittingRef.current = false;
      setPhase("idle");

      // Severity and behaviour are decided by the status code, never by the
      // message text - an unrecognised server string must not silently
      // become the wrong tone or skip the field-invalid treatment.
      if (result.status === 401) {
        void hapticNotify("error");
        setInvalid(true);
        setNotice({
          tone: "danger",
          message: "Sähköposti tai salasana on väärin. Tarkista ja yritä uudelleen.",
        });
        triggerShake();
        if (passwordRef.current) passwordRef.current.value = "";
        passwordRef.current?.focus();
        return;
      }

      if (result.status === 429) {
        const wait =
          result.retryAfter && result.retryAfter > 0
            ? ` Yritä uudelleen ${formatRetryAfter(result.retryAfter)} kuluttua.`
            : " Yritä myöhemmin uudelleen.";
        setNotice({ tone: "danger", message: `Liian monta kirjautumisyritystä.${wait}` });
        return;
      }

      // AUTH-09: only a message written for the user is shown; a raw
      // server string ("PrismaClient...", "fail") goes to the console.
      setNotice({
        tone: "danger",
        message: errorMessage(new ApiError(result.error, result.status), "Kirjautuminen epäonnistui"),
      });
    } catch {
      // fetch() itself threw: offline, DNS failure, TLS/tunnel down - the
      // request never reached the server at all.
      submittingRef.current = false;
      setPhase("idle");
      setNotice({ tone: "danger", message: "Ei yhteyttä palvelimeen. Tarkista verkkoyhteys." });
    }
  }

  const noticeId = "login-notice";
  const fieldClass = (extra = "") => `${controlClass}${invalid ? " !border-danger" : ""} ${extra}`.trim();

  return (
    // SHELL-22 / AUTH-07: one scroll frame that follows the usable area, so a
    // keyboard lifts it and a short viewport scrolls instead of clipping.
    <BareFrame>
      <div>
        <ConnectivityBanner />
        <div className="mb-8 flex flex-col items-center text-center">
          <AppMark size={64} className="mb-4" />
          <h1 className="text-[32px] font-bold leading-tight tracking-[-0.02em] text-ink">LashKirja</h1>
          <p className="mt-2 text-[15px] text-ink-2">Kirjanpito yksinkertaisesti</p>
        </div>

        {/* action/method kept as a no-JS fallback: with JS disabled (or if
            fetch throws before it can run), the browser still POSTs here
            natively and the route's existing 303-redirect branch handles it. */}
        <form
          action="/api/auth/login"
          method="POST"
          onSubmit={handleSubmit}
          onAnimationEnd={() => setShake(false)}
          className={`space-y-5 rounded-card border border-line bg-surface p-8 transition-colors duration-300 ${
            shake ? "animate-shake" : ""
          }`}
        >
          {next && <input type="hidden" name="next" value={next} />}

          <Field label="Sähköposti" htmlFor="email">
            <input
              ref={emailRef}
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              className={fieldClass()}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? noticeId : undefined}
              onChange={clearNoticeOnEdit}
              required
            />
          </Field>

          <PasswordField
            ref={passwordRef}
            id="password"
            name="password"
            label="Salasana"
            autoComplete="current-password"
            enterKeyHint="go"
            inputClassName={invalid ? "!border-danger" : ""}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? noticeId : undefined}
            onChange={clearNoticeOnEdit}
            required
          />

          {notice && <LoginNotice id={noticeId} tone={notice.tone} message={notice.message} />}

          <Button type="submit" busy={phase === "submitting"} busyLabel="Kirjaudutaan…" className="w-full">
            {phase === "success" ? (
              <span className="inline-flex items-center gap-2">
                <Icon icon={Check} size="inline" />
                Kirjaudu sisään
              </span>
            ) : (
              "Kirjaudu sisään"
            )}
          </Button>
          <Link
            href="/unohtunut-salasana"
            className="active-press flex min-h-11 items-center justify-center text-sm text-accent"
          >
            Unohditko salasanan?
          </Link>
        </form>

        {SHOW_DEMO_LOGIN && (
          <p className="mt-6 text-center text-xs text-ink-2">
            Demo: demo@lashkirja.fi / demo123
          </p>
        )}
      </div>
    </BareFrame>
  );
}
