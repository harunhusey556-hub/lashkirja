"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeftRight, Camera, Circle, CircleCheck, Copy, FilePen, FileUp, Percent, Tag, type LucideIcon } from "lucide-react";
import { ActionPill, BottomActions, Icon, ListRow, PageTitle, Section } from "@/components/ds";
import { SectionSkeleton } from "@/components/books/Skeletons";
import { ConnectionNotice } from "@/components/ScreenState";
import ConfirmModal from "@/components/ConfirmModal";
import { Button } from "@/components/ui";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { useProfile } from "@/app/asetukset/useProfile";
import { useVatDue } from "@/components/useVatDue";
import type { DashboardItem, DashboardItemKind } from "@/app/api/dashboard/items";
import { MONTHS } from "@/lib/finnish-months";
import { formatDayMonth, formatEur } from "@/lib/format";
import { detailHref } from "@/lib/routes";
import { helsinkiMonthKey } from "@/lib/validation";
import { vatPeriodEndingIn, vatPeriodKindOf } from "@/lib/vat-deadline";
import { vatDueSecondary, vatFilingState } from "@/lib/vat-due";
import { approvalGapText } from "@/lib/receipt-approval";
import { requestReceiptCapture } from "@/lib/capture-request";
import { hapticNotify } from "@/lib/haptics";
import { showToast } from "@/lib/toast";
import { PERIOD_LOCK_KEY, storeCached } from "@/lib/cached-resource";

/**
 * Kuukauden sulkeminen (FP-13, TF-07): one month's finish line.
 *
 * The checklist is the same list Koti counts (api/dashboard/items.ts, all of
 * it instead of three per kind), so "Elokuu: 2 asiaa kesken" on Koti and the
 * two rows here are one fact. The VAT step shows the return's state and
 * links to its one home, the ALV page, where it is marked filed and paid.
 * The screen ends with one primary action that closes (locks) the month.
 */

interface MonthStatus {
  month: string;
  ended: boolean;
  locked: boolean;
  lockedThrough: string | null;
  items: DashboardItem[];
  totals: Record<DashboardItemKind, number>;
  blockingTotal: number;
  progress: { matchable: number; matched: number; suggested: number };
  hasStatement: boolean;
}

function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthName(month: string): string {
  return MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

interface Step {
  key: string;
  icon: LucideIcon;
  title: string;
  done: boolean;
  doneText: string;
  openText: string;
  items: DashboardItem[];
}

function itemRow(item: DashboardItem) {
  switch (item.kind) {
    case "pending_receipt": {
      const gaps = item.gaps ?? [];
      return (
        <ListRow
          key={item.id}
          href={detailHref("receipt", item.receiptId)}
          leading={<Icon icon={Tag} />}
          title={item.party}
          amount={item.amount == null ? undefined : formatEur(item.amount)}
          secondary={gaps.length > 0 ? approvalGapText(gaps) : "Odottaa hyväksyntää"}
          chevron
        />
      );
    }
    case "missing_receipt":
      return (
        <ListRow
          key={item.id}
          href="/pankki/taydennys"
          leading={<Icon icon={Camera} />}
          title={item.party}
          amount={formatEur(Math.abs(item.amount))}
          amountTone={item.amount > 0 ? "positive" : "default"}
          secondary={item.date ? `Kuitti puuttuu · ${formatDayMonth(item.date)}` : "Kuitti puuttuu"}
          trailing={
            <ActionPill
              onClick={() => requestReceiptCapture({ transactionId: item.transactionId, label: item.party })}
              ariaLabel={`Lisää kuva: ${item.party}`}
            >
              Lisää kuva
            </ActionPill>
          }
        />
      );
    case "receipt_match":
      return (
        <ListRow
          key={item.id}
          href="/pankki/taydennys"
          leading={<Icon icon={ArrowLeftRight} />}
          title={item.party}
          amount={formatEur(Math.abs(item.amount))}
          secondary="Kohdistusehdotus · tarkista"
          chevron
        />
      );
    case "invoice_match":
      return (
        <ListRow
          key={item.id}
          href={detailHref("invoice", item.invoiceId)}
          leading={<Icon icon={ArrowLeftRight} />}
          title={item.party}
          amount={`+${formatEur(item.amount)}`}
          amountTone="positive"
          secondary={`Maksu laskulle ${item.number}? Kohdista`}
          chevron
        />
      );
    case "payment_duplicate":
      return (
        <ListRow
          key={item.id}
          href={detailHref("invoice", item.invoiceId)}
          leading={<Icon icon={Copy} />}
          title={item.party}
          amount={formatEur(item.amount)}
          secondary={`Sama tulo kahdesti? Lasku ${item.number}`}
          chevron
        />
      );
    case "draft_invoice":
      return (
        <ListRow
          key={item.id}
          href={detailHref("invoice", item.invoiceId)}
          leading={<Icon icon={FilePen} />}
          title={item.party}
          amount={formatEur(item.amount)}
          secondary={`Lasku ${item.number} · lähettämättä`}
          chevron
        />
      );
    default:
      return null;
  }
}

export default function Page() {
  return (
    <Suspense fallback={<MonthCloseSkeleton />}>
      <MonthClose />
    </Suspense>
  );
}

function MonthCloseSkeleton() {
  return (
    <div className="space-y-6">
      <SectionSkeleton rows={4} />
    </div>
  );
}

function MonthClose() {
  const params = useSearchParams();
  const raw = params.get("month");
  const month = raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : previousMonth(helsinkiMonthKey());
  const { profile } = useProfile();

  const [status, setStatus] = useState<{ month: string; data: MonthStatus } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch(`/api/dashboard/month?month=${month}`, { credentials: "include", signal: controller.signal })
      .then((response) => readJson<MonthStatus>(response, "Kuukauden tietojen lataus epäonnistui"))
      .then((data) => {
        if (controller.signal.aborted) return;
        setLoadError(null);
        setStatus({ month, data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setLoadError(error);
      });
    return () => controller.abort();
  }, [month, attempt]);

  const data = status?.month === month ? status.data : null;
  const kind = vatPeriodKindOf(profile?.vatPeriod);
  const vatPeriod = vatPeriodEndingIn(month, kind);
  const vat = useVatDue(vatPeriod ? profile : null, vatPeriod);
  const name = monthName(month);
  const year = month.slice(0, 4);

  const byKind = (kinds: DashboardItemKind[]) => (data?.items ?? []).filter((item) => kinds.includes(item.kind));
  const count = (kinds: DashboardItemKind[]) => kinds.reduce((sum, k) => sum + (data?.totals?.[k] ?? 0), 0);

  const receiptKinds: DashboardItemKind[] = ["pending_receipt"];
  const bankKinds: DashboardItemKind[] = ["missing_receipt", "receipt_match", "invoice_match", "payment_duplicate"];
  const invoiceKinds: DashboardItemKind[] = ["draft_invoice"];

  const steps: Step[] = data
    ? [
        {
          key: "receipts",
          icon: Tag,
          title: "Kuitit",
          done: count(receiptKinds) === 0,
          doneText: "Kaikki kuitit on hyväksytty",
          openText: `${plural(count(receiptKinds), "kuitti odottaa", "kuittia odottaa")} hyväksyntää`,
          items: byKind(receiptKinds),
        },
        {
          key: "bank",
          icon: ArrowLeftRight,
          title: "Pankkitapahtumat",
          done: count(bankKinds) === 0,
          doneText: data.hasStatement
            ? `${data.progress.matched} / ${data.progress.matchable} pankkitapahtumaa kunnossa`
            : "Tiliotetta ei ole tuotu",
          openText: `${plural(count(bankKinds), "pankkitapahtuma", "pankkitapahtumaa")} kesken`,
          items: byKind(bankKinds),
        },
        {
          key: "invoices",
          icon: FilePen,
          title: "Myyntilaskut",
          done: count(invoiceKinds) === 0,
          doneText: "Ei lähettämättömiä laskuja",
          openText: `${plural(count(invoiceKinds), "lasku", "laskua")} lähettämättä`,
          items: byKind(invoiceKinds),
        },
      ]
    : [];

  const vatState = vat.figures ? vatFilingState(vat.figures.filing) : null;
  const vatDone = vatState === "paid" || (vatState === "filed" && vat.figures?.isRefund === true);
  const blocking = data?.blockingTotal ?? 0;
  const earlierOpen = data ? (data.lockedThrough ?? "") < previousMonth(month) : false;

  async function closeMonth() {
    setClosing(true);
    try {
      const response = await apiFetch("/api/period-lock", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const result = await readJson<{ lockedThrough: string | null }>(response, "Kuukauden sulkeminen epäonnistui");
      storeCached(PERIOD_LOCK_KEY, { lockedThrough: result.lockedThrough });
      setConfirmOpen(false);
      void hapticNotify("success");
      showToast({ tone: "success", text: `${name} on merkitty valmiiksi.` });
      setAttempt((a) => a + 1);
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setConfirmOpen(false);
      showToast({ tone: "error", text: errorMessage(error, "Kuukauden sulkeminen epäonnistui") });
    } finally {
      setClosing(false);
    }
  }

  const subtitle = !data
    ? " "
    : data.locked
      ? "Kuukausi on suljettu."
      : !data.ended
        ? "Kuukausi on vielä kesken."
        : blocking > 0
          ? `${plural(blocking, "asia", "asiaa")} kesken`
          : "Kaikki kirjattu. Voit sulkea kuukauden.";

  return (
    <div className="space-y-6">
      <PageTitle title={`${name} ${year}`} subtitle={subtitle} />

      {loadError != null && !data ? (
        <ConnectionNotice
          error={loadError}
          fallback="Kuukauden tietojen lataus epäonnistui"
          onRetry={() => {
            setLoadError(null);
            setAttempt((a) => a + 1);
          }}
        />
      ) : !data ? (
        <MonthCloseSkeleton />
      ) : (
        <>
          {steps.map((step) => (
            <Section key={step.key} title={step.title}>
              <ListRow
                leading={<Icon icon={step.done ? CircleCheck : Circle} className={step.done ? "text-success" : "text-ink-2"} />}
                title={step.done ? step.doneText : step.openText}
                ariaLabel={`${step.title}: ${step.done ? step.doneText : step.openText}`}
              />
              {step.items.map(itemRow)}
              {step.key === "bank" && !data.hasStatement ? (
                <ListRow
                  href="/pankki/tapahtumat?import=1"
                  leading={<Icon icon={FileUp} />}
                  title="Tuo kuukauden tiliote"
                  secondary="Ilman tiliotetta puuttuvia kuitteja ei näe"
                  chevron
                />
              ) : null}
            </Section>
          ))}

          {vat.due ? (
            <Section title="ALV">
              <ListRow
                href={vat.due.queryKey ? `/kirjanpito/alv?period=${vat.due.queryKey}` : "/kirjanpito/alv"}
                leading={<Icon icon={vatDone ? CircleCheck : Percent} className={vatDone ? "text-success" : undefined} />}
                title="ALV-ilmoitus"
                amount={vat.figures ? formatEur(vat.figures.amount) : undefined}
                secondary={vatDueSecondary(vat.due, vat.figures)}
                chevron
              />
              {!vatDone ? (
                <ListRow
                  href={vat.due.queryKey ? `/kirjanpito/alv?period=${vat.due.queryKey}#ilmoita` : "/kirjanpito/alv"}
                  title="Ilmoita ja maksa OmaVerossa"
                  secondary="Ohjeet ja merkintä ALV-sivulla"
                  chevron
                />
              ) : null}
            </Section>
          ) : null}

          {data.locked ? (
            <p className="px-1 text-caption text-ink-2">
              Suljetun kuukauden kuitteja, laskuja ja tapahtumia ei voi muuttaa.{" "}
              <Link
                href="/kirjanpito/kaudet"
                className="relative font-medium text-accent before:absolute before:inset-x-0 before:-inset-y-3 before:content-['']"
              >
                Suljetut kaudet
              </Link>
            </p>
          ) : (
            <BottomActions>
              <Button
                className="w-full"
                busy={closing}
                busyLabel="Suljetaan…"
                disabled={!data.ended}
                disabledReason={data.ended ? undefined : "Kuukauden voi sulkea, kun se on päättynyt."}
                onClick={() => setConfirmOpen(true)}
              >
                {`Merkitse ${name.toLowerCase()} valmiiksi`}
              </Button>
            </BottomActions>
          )}

          <ConfirmModal
            isOpen={confirmOpen}
            title={`Merkitäänkö ${name.toLowerCase()} valmiiksi?`}
            description={[
              blocking > 0 ? `${plural(blocking, "asia", "asiaa")} on vielä kesken.` : null,
              vat.due && !vatDone ? "ALV-ilmoitusta ei ole merkitty annetuksi." : null,
              "Kuukausi suljetaan: sen kuitteja, laskuja ja pankkitapahtumia ei voi enää muuttaa.",
              earlierOpen ? "Myös aiemmat sulkemattomat kuukaudet suljetaan." : null,
            ]
              .filter(Boolean)
              .join(" ")}
            confirmLabel="Merkitse valmiiksi"
            isDestructive={false}
            onConfirm={() => void closeMonth()}
            onCancel={() => setConfirmOpen(false)}
          />
        </>
      )}
    </div>
  );
}
