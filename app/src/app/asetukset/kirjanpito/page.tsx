"use client";

import AppShell from "@/components/AppShell";
import BooksLockCard from "@/components/BooksLockCard";

export default function KirjanpitoAsetuksetPage() {
  return (
    <AppShell>
      <div className="space-y-6 animate-in">
        <p className="text-sm text-warm-gray">
          Lukitse kirjanpito ilmoitettuun kuukauteen asti — lukitut kaudet
          muuttuvat vain tarkoituksella.
        </p>
        <BooksLockCard />
      </div>
    </AppShell>
  );
}
