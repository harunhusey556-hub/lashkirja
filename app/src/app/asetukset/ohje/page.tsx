"use client";

import { useState } from "react";
import { errorReference } from "@/lib/screen-state";
import { BuildInfo } from "@/components/BuildInfo";
import { Card, PageTitle } from "@/components/ds";
import { buttonClass } from "@/components/control-styles";

export default function OhjePage() {
  const [supportNote, setSupportNote] = useState("");

  async function copySupport(kind: "report" | "reference") {
    const reference = errorReference(process.env.NEXT_PUBLIC_GIT_COMMIT || "unknown");
    const text =
      kind === "reference"
        ? reference
        : `LashKirja-ongelma\nViite: ${reference}\nSivu: ${window.location.pathname}`;
    try {
      await navigator.clipboard.writeText(text);
      setSupportNote(kind === "reference" ? "Virheviite kopioitu." : "Tukiviesti kopioitu. Liitä se sähköpostiin.");
    } catch {
      setSupportNote(text);
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Ohje ja tuki" />
      <Card className="space-y-3">
        <p className="text-[15px] text-ink leading-relaxed">
          Kuitit, laskut ja ALV löytyvät omista näkymistään. Jos jokin epäonnistuu, kopioi virheviite ja liitä se tukiviestiin.
        </p>
        <button type="button" className={buttonClass("secondary", "w-full")} onClick={() => void copySupport("report")}>
          Ilmoita ongelmasta
        </button>
        <button type="button" className={buttonClass("secondary", "w-full")} onClick={() => void copySupport("reference")}>
          Kopioi virheviite
        </button>
        {supportNote && (
          <p className="text-[13px] text-ink-2" role="status">
            {supportNote}
          </p>
        )}
        <BuildInfo />
      </Card>
    </div>
  );
}
