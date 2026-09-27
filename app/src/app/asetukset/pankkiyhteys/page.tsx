"use client";

import BankConnectCard from "@/components/BankConnectCard";
import { ConnectionNotice } from "@/components/ScreenState";
import { useProfile } from "../useProfile";

export default function PankkiyhteysPage() {
  const { profile, loadError, retry } = useProfile();
  if (loadError) {
    return <ConnectionNotice error={new Error(loadError)} fallback={loadError} onRetry={retry} />;
  }
  if (!profile) {
    return (
      <div className="bg-white rounded-2xl p-6 shadow-sm">
        <div className="h-24 rounded-xl bg-warm-gray-light/20 skeleton" />
      </div>
    );
  }
  return <BankConnectCard entityType={profile.entityType} />;
}
