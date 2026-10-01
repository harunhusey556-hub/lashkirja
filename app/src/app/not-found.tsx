"use client";

import { SearchX } from "lucide-react";
import { FullScreenNotice } from "@/components/ScreenState";

export default function NotFound() {
  return (
    <FullScreenNotice
      icon={SearchX}
      title="Sivua ei löytynyt"
      body="Osoite on virheellinen tai sivu on poistettu."
      actionLabel="Palaa Kotiin"
      href="/dashboard"
    />
  );
}
