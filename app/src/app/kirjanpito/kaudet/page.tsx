"use client";

import BooksLockCard from "@/components/BooksLockCard";
import { PageTitle } from "@/components/ds";

export default function KirjanpitoAsetuksetPage() {
  return (
    <div className="space-y-6">
      <PageTitle
        title="Suljetut kaudet"
        subtitle="Lukitse kirjanpito ilmoitettuun kuukauteen asti. Lukittuja kausia muutetaan vain tarkoituksella."
      />
      <BooksLockCard />
    </div>
  );
}
