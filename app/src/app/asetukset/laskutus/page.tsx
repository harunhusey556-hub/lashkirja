"use client";

import SellerProfileCard from "@/components/SellerProfileCard";

export default function LaskutusAsetuksetPage() {
  return (
    <>
      <div className="space-y-6 animate-in">
        <p className="text-sm text-warm-gray">
          Nämä tiedot tulostuvat myyntilaskuillesi ja maksumuistutuksiin.
        </p>
        <SellerProfileCard />
      </div>
    </>
  );
}
