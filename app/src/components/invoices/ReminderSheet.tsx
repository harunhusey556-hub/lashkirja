"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import BottomSheet from "@/components/BottomSheet";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { Button, buttonClass } from "@/components/ui";
import { Skeleton, SkeletonGroup } from "@/components/ds";
import { formatEur } from "@/lib/format";
import { detailHref } from "@/lib/routes";
import { showToast } from "@/lib/toast";
import { hapticNotify } from "@/lib/haptics";

export interface ReminderPreview {
  level: number;
  daysLate: number;
  open: number;
  interest: number;
  fee: number;
  total: number;
  dueDate: string;
  recipient: string | null;
  previousReminders: Array<{ level: number; sentAt: string; total: number }>;
}

/**
 * The payment reminder review: what is sent, to whom, and for how much,
 * then one "Lähetä muistutus". Used by the invoice page (which already holds
 * the preview) and by Koti's "Muistuta" (which loads it when the sheet opens).
 */
export function ReminderSheet({
  invoiceId,
  customerId,
  isOpen,
  preview,
  onClose,
  onSent,
}: {
  invoiceId: string;
  customerId: string;
  isOpen: boolean;
  /** Already loaded by the caller; when absent the sheet loads it itself. */
  preview?: ReminderPreview | null;
  onClose: () => void;
  onSent: (result: { level: number; sentTo: string }) => void;
}) {
  const [loaded, setLoaded] = useState<{ id: string; preview: ReminderPreview } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const selfLoads = preview === undefined;

  useEffect(() => {
    if (!isOpen || !selfLoads) return;
    let cancelled = false;
    apiFetch(`/api/invoices/${invoiceId}/reminders`, { credentials: "include" })
      .then((response) => readJson<{ reminder: ReminderPreview }>(response, "Muistutuksen tietoja ei saatu ladattua"))
      .then((data) => {
        if (cancelled) return;
        setLoadError(null);
        setLoaded({ id: invoiceId, preview: data.reminder });
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(failure)) {
          redirectToLogin();
          return;
        }
        setLoadError(failure);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, selfLoads, invoiceId, attempt]);

  const reminder = selfLoads ? (loaded?.id === invoiceId ? loaded.preview : null) : preview;

  function close() {
    setError("");
    setLoadError(null);
    onClose();
  }

  async function send() {
    setSending(true);
    setError("");
    try {
      const response = await apiFetch(`/api/invoices/${invoiceId}/reminders`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = await readJson<{ sentTo: string; reminder: { level: number } }>(
        response,
        "Muistutuksen lähetys epäonnistui"
      );
      // The success toast gives the haptic itself (ToastHost), so none here.
      showToast({
        tone: "success",
        text: `Maksumuistutus ${result.reminder.level} lähetettiin osoitteeseen ${result.sentTo}`,
      });
      setLoaded(null);
      onSent({ level: result.reminder.level, sentTo: result.sentTo });
    } catch (failure) {
      if (isUnauthorized(failure)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(failure, "Muistutuksen lähetys epäonnistui"));
      void hapticNotify("error");
    } finally {
      setSending(false);
    }
  }

  return (
    <BottomSheet
      isOpen={isOpen && (reminder !== null || selfLoads)}
      onClose={close}
      title="Lähetä maksumuistutus"
      labelledBy="reminder-sheet-title"
    >
      <div className="space-y-3 px-5 py-4 sheet-safe-bottom">
        {!reminder ? (
          loadError ? (
            <div className="space-y-3">
              <p className="text-sm text-danger" role="alert">
                {errorMessage(loadError, "Muistutuksen tietoja ei saatu ladattua")}
              </p>
              <Button type="button" variant="secondary" className="w-full" onClick={() => setAttempt((a) => a + 1)}>
                Yritä uudelleen
              </Button>
            </div>
          ) : (
            <SkeletonGroup label="Ladataan muistutusta" className="space-y-2">
              <Skeleton tone="soft" className="h-3.5 w-2/5" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-12 w-full" radius="card" />
            </SkeletonGroup>
          )
        ) : (
          <>
            <p className="text-[13px] text-ink-2">
              Muistutus {reminder.level} · myöhässä {reminder.daysLate} päivää
            </p>
            <div className="space-y-1 text-[15px]">
              <div className="flex justify-between gap-3">
                <span className="shrink-0 text-ink-2">Vastaanottaja</span>
                <span className="min-w-0 break-all text-right text-ink">{reminder.recipient ?? "–"}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-ink-2">Avoin pääoma</span>
                <span className="tabular-nums text-ink">{formatEur(reminder.open)}</span>
              </div>
              {reminder.interest > 0 && (
                <div className="flex justify-between gap-3">
                  <span className="text-ink-2">Viivästyskorko</span>
                  <span className="tabular-nums text-ink">{formatEur(reminder.interest)}</span>
                </div>
              )}
              {reminder.fee > 0 && (
                <div className="flex justify-between gap-3">
                  <span className="text-ink-2">Muistutusmaksu</span>
                  <span className="tabular-nums text-ink">{formatEur(reminder.fee)}</span>
                </div>
              )}
              <div className="flex justify-between gap-3 font-semibold text-ink">
                <span>Maksettava yhteensä</span>
                <span className="tabular-nums">{formatEur(reminder.total)}</span>
              </div>
            </div>
            {!reminder.recipient && (
              <div className="space-y-2">
                <p className="text-sm text-danger" role="alert">
                  Asiakkaalla ei ole sähköpostiosoitetta.
                </p>
                <Link href={detailHref("customer", customerId)} className={buttonClass("secondary", "w-full")}>
                  Lisää asiakkaalle sähköposti
                </Link>
              </div>
            )}
            {error && (
              <p className="text-sm text-danger" role="alert">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                className="flex-1"
                disabled={!reminder.recipient}
                disabledReason={!reminder.recipient ? "Sähköpostiosoite puuttuu." : undefined}
                busy={sending}
                busyLabel="Lähetetään…"
                onClick={() => void send()}
              >
                Lähetä muistutus
              </Button>
              <Button type="button" variant="secondary" className="flex-1" onClick={close}>
                Peruuta
              </Button>
            </div>
          </>
        )}
      </div>
    </BottomSheet>
  );
}
