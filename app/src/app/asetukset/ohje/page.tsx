"use client";

import { useState } from "react";
import { errorReference } from "@/lib/screen-state";
import { shareContent } from "@/lib/share";
import { reportCopiedToast, supportContactLine, supportEmail } from "@/lib/account-copy";
import { hapticNotify } from "@/lib/haptics";
import { showToast } from "@/lib/toast";
import { BuildInfo } from "@/components/BuildInfo";
import { ClipboardList } from "lucide-react";
import { Card, Icon, ListRow, PageTitle, Section } from "@/components/ds";
import { buttonClass } from "@/components/control-styles";

/** Shown and used as the mail recipient when the build carries one (NEXT_PUBLIC_SUPPORT_EMAIL). */
const SUPPORT_EMAIL = supportEmail();

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
      await copy(text, reportCopiedToast(SUPPORT_EMAIL));
    } catch {
      await copy(text, reportCopiedToast(SUPPORT_EMAIL));
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
        <p className="text-body text-ink">
          Kuitit, laskut ja ALV löytyvät omista näkymistään. Jos jokin epäonnistuu, lähetä viesti: siihen tulee
          mukaan tukikoodi, jonka avulla vika löytyy.
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
          onClick={() => void copy(reference(), "Tukikoodi kopioitu.")}
        >
          Kopioi tukikoodi
        </button>
        {SUPPORT_EMAIL ? (
          <p className="text-body text-ink-2">
            Voit myös kirjoittaa suoraan osoitteeseen{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="active-press inline-flex min-h-11 items-center font-medium text-accent"
            >
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        ) : (
          <p className="text-body text-ink-2">{supportContactLine("")}</p>
        )}
        <BuildInfo />
      </Card>
      {/* The background-job log is for troubleshooting, not everyday bookkeeping:
          it left the Kirjanpito hub and Kuitit (owner report 2026-09-30). */}
      <Section>
        <ListRow
          href="/tyot"
          leading={<Icon icon={ClipboardList} />}
          chevron
          title="Huomioitavat"
          secondary="Tuonnit, haut ja niiden virheet"
        />
      </Section>
    </div>
  );
}
