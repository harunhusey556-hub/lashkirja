"use client";

import { useState } from "react";
import { errorReference } from "@/lib/screen-state";
import { shareContent } from "@/lib/share";
import { hapticNotify } from "@/lib/haptics";
import { showToast } from "@/lib/toast";
import { BuildInfo } from "@/components/BuildInfo";
import { Card, PageTitle } from "@/components/ds";
import { buttonClass } from "@/components/control-styles";

/** Shown and used as the mail recipient when the build carries one (NEXT_PUBLIC_SUPPORT_EMAIL). */
const SUPPORT_EMAIL = (process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "").trim();

export default function OhjePage() {
  const [busy, setBusy] = useState(false);

  function reference(): string {
    return errorReference(process.env.NEXT_PUBLIC_GIT_COMMIT || "unknown");
  }

  /** AUTH-18: the share sheet (Mail, Messages ...) with the message filled in; copy is only the fallback. */
  async function reportProblem() {
    if (busy) return;
    setBusy(true);
    const text = `LashKirja-ongelma\nViite: ${reference()}\nSivu: ${window.location.pathname}\n\nKerro tähän, mitä yritit tehdä:\n`;
    try {
      const result = await shareContent({ title: "LashKirja-ongelma", text });
      if (result === "shared" || result === "cancelled") return;
      await copy(text, "Viesti kopioitu. Liitä se sähköpostiin.");
    } catch {
      await copy(text, "Viesti kopioitu. Liitä se sähköpostiin.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast({ tone: "success", text: done });
    } catch {
      void hapticNotify("error");
      showToast({ tone: "error", text: "Kopiointi ei onnistunut tällä laitteella." });
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Ohje ja tuki" />
      <Card className="space-y-3">
        <p className="text-[15px] text-ink leading-relaxed">
          Kuitit, laskut ja ALV löytyvät omista näkymistään. Jos jokin epäonnistuu, lähetä meille viesti: siihen tulee
          mukaan virheviite, jonka avulla vika löytyy.
        </p>
        <button
          type="button"
          className={buttonClass("primary", "w-full")}
          onClick={() => void reportProblem()}
          aria-busy={busy || undefined}
        >
          Ilmoita ongelmasta
        </button>
        <button
          type="button"
          className={buttonClass("secondary", "w-full")}
          onClick={() => void copy(reference(), "Virheviite kopioitu.")}
        >
          Kopioi virheviite
        </button>
        {SUPPORT_EMAIL && (
          <p className="text-[15px] text-ink-2">
            Tuki:{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="active-press inline-flex min-h-11 items-center font-medium text-accent"
            >
              {SUPPORT_EMAIL}
            </a>
          </p>
        )}
        <BuildInfo />
      </Card>
    </div>
  );
}
