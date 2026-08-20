"use client";

import AppShell from "@/components/AppShell";
import SellerProfileCard from "@/components/SellerProfileCard";

export default function LaskutusAsetuksetPage() {
  return (
    <AppShell>
      <div className="space-y-6 animate-in">
        <p className="text-sm text-warm-gray">
          Nämä tiedot tulostuvat myyntilaskuillesi ja maksumuistutuksiin.
        </p>
        <SellerProfileCard />
      </div>
    </AppShell>
  );
}
