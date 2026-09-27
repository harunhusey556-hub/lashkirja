"use client";

import { useState } from "react";
import { errorReference } from "@/lib/screen-state";
import { BuildInfo } from "@/components/BuildInfo";

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
    <section className="bg-white rounded-2xl p-6 shadow-sm space-y-3">
      <h2 className="text-sm font-medium text-charcoal">Ohje ja tuki</h2>
      <p className="text-sm text-charcoal leading-relaxed">
        Kuitit, laskut ja ALV löytyvät omista näkymistään. Jos jokin epäonnistuu, kopioi virheviite ja liitä se tukiviestiin.
      </p>
      <button
        type="button"
        className="w-full min-h-11 rounded-xl border border-warm-gray-light/70 text-sm font-medium text-charcoal active-press"
        onClick={() => void copySupport("report")}
      >
        Ilmoita ongelmasta
      </button>
      <button
        type="button"
        className="w-full min-h-11 rounded-xl border border-warm-gray-light/70 text-sm font-medium text-charcoal active-press"
        onClick={() => void copySupport("reference")}
      >
        Kopioi virheviite
      </button>
      {supportNote && (
        <p className="text-xs text-warm-gray" role="status">
          {supportNote}
        </p>
      )}
      <BuildInfo />
    </section>
  );
}
