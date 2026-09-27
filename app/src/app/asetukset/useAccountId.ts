"use client";

import { useEffect, useState } from "react";
import { apiFetch, readJson } from "@/components/clientFetch";

export function useAccountId(): string | null {
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void apiFetch("/api/auth/me")
      .then((response) => readJson<{ user: { userId?: string } | null }>(response, ""))
      .then((data) => {
        if (!cancelled) setUserId(data.user?.userId ?? null);
      })
      .catch(() => {
        if (!cancelled) setUserId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return userId;
}
