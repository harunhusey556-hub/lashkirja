"use client";

import { PageTitle } from "@/components/ds";
import SellerProfileCard from "@/components/SellerProfileCard";

export default function LaskutusAsetuksetPage() {
  return (
    <div className="space-y-6">
      {/* R4: no subtitle on a form page. */}
      <PageTitle title="Laskuttajan tiedot" />
      <SellerProfileCard />
    </div>
  );
}
