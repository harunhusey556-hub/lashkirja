"use client";

import { PageTitle } from "@/components/ds";
import SellerProfileCard from "@/components/SellerProfileCard";

export default function LaskutusAsetuksetPage() {
  return (
    <div className="space-y-6">
      <PageTitle title="Laskuttajan tiedot" subtitle="Nämä tiedot tulostuvat myyntilaskuillesi ja maksumuistutuksiin." />
      <SellerProfileCard />
    </div>
  );
}
