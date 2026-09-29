"use client";

import BooksLockCard from "@/components/BooksLockCard";
import { PageTitle } from "@/components/ds";

export default function KirjanpitoAsetuksetPage() {
  return (
    <div className="space-y-6">
      {/* One short subtitle: the page fits a 320 x 568 screen without a jitter scroll. */}
      <PageTitle title="Suljetut kaudet" subtitle="Lukittuja kuukausia ei voi muuttaa." />
      <BooksLockCard />
    </div>
  );
}
