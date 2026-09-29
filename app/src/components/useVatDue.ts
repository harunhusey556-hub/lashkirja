"use client";

import { useMemo } from "react";
import { apiFetch, readJson } from "@/components/clientFetch";
import { useCachedResource } from "@/components/useCachedResource";
import { alvSummaryKey } from "@/lib/cached-resource";
import { nextVatDue, vatDueFor, vatPeriodKindOf, type VatDue, type VatPeriod } from "@/lib/vat-deadline";
import type { VatDueFigures, VatFilingRecord } from "@/lib/vat-due";

interface ProfileLike {
  vatRegistered?: boolean;
  vatPeriod?: string | null;
}

/**
 * FP-4: the one VAT deadline every screen shows. The period comes from
 * `nextDueVatPeriod` (or an explicit period, for a past month's close), the
 * figures from `/api/alv` through one shared cache key, so Koti and
 * Kirjanpito paint the same value from the same cache entry.
 *
 * - `due === null`: not VAT registered (or the profile is not known yet).
 * - `figures === null` with `waiting`: loading; without: a yearly filer, or
 *   the fetch failed with nothing cached.
 */
export function useVatDue(profile: ProfileLike | null | undefined, period?: VatPeriod | null) {
  const registered = Boolean(profile?.vatRegistered);
  const kind = vatPeriodKindOf(profile?.vatPeriod);
  const explicitKey = period ? `${period.kind}:${period.year}:${period.month ?? period.quarter ?? ""}` : "";
  const due = useMemo<VatDue | null>(() => {
    if (!registered) return null;
    return period ? vatDueFor(period) : nextVatDue(new Date(), kind);
    // `period` is compared by value through explicitKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registered, kind, explicitKey]);

  const query = due?.queryKey ?? null;
  const fetch = useCachedResource<VatDueFigures>(query ? alvSummaryKey(query) : null, async (signal) => {
    const response = await apiFetch(`/api/alv?period=${query}`, { credentials: "include", signal });
    const data = await readJson<{
      field308: { amount: number; isRefund: boolean };
      filing?: VatFilingRecord | null;
      pendingReceiptCount?: number;
    }>(response, "");
    return {
      amount: data.field308.amount,
      isRefund: data.field308.isRefund,
      filing: data.filing ?? null,
      pendingReceiptCount: data.pendingReceiptCount ?? 0,
    };
  });

  // A cache entry written before the filing fields existed reads as "no filing yet".
  const figures: VatDueFigures | null = fetch.value
    ? {
        amount: fetch.value.amount,
        isRefund: fetch.value.isRefund,
        filing: fetch.value.filing ?? null,
        pendingReceiptCount: fetch.value.pendingReceiptCount ?? 0,
      }
    : null;

  return {
    due,
    figures,
    waiting: query !== null && fetch.value === null && !fetch.failed,
    failed: fetch.failed,
    reload: fetch.reload,
  };
}
