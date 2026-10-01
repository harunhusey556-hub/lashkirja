"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeftRight, Camera, Circle, CircleCheck, CircleDashed, Copy, FilePen, FileUp, Percent, Tag, type LucideIcon } from "lucide-react";
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
import { vatChangedNote, vatChangedSinceFiling, vatDueSecondary, vatFilingState, vatNothingToPay } from "@/lib/vat-due";
import { checkStepState, monthCloseButton, monthCloseComplete, monthCloseSubtitle, monthCloseWarnings, type StepState } from "@/lib/month-close";
import { approvalGapText } from "@/lib/receipt-approval";
import { requestReceiptCapture, requestStatementImport } from "@/lib/capture-request";
import { MonthDone } from "./MonthDone";
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
  /** F10: receipts and sales documents dated in the month, and whether the month holds anything at all. */
  receiptCount: number;
  invoiceCount: number;
  hasContent: boolean;
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
  /** none: nothing in the month to check, so no tick (F10). */
  state: StepState;
  doneText: string;
  openText: string;
  noneText: string;
  items: DashboardItem[];
}

function stepText(step: Step): string {
  return step.state === "done" ? step.doneText : step.state === "open" ? step.openText : step.noneText;
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
    case "vat_gap":
      return (
        <ListRow
          key={item.id}
          href={detailHref("receipt", item.receiptId)}
          leading={<Icon icon={Percent} />}
          title={item.party}
          amount={formatEur(item.amount)}
          secondary={item.type === "meno" ? "ALV-erittely puuttuu · vähennys jää pois" : "ALV-erittely puuttuu · ei mukana ALV:ssa"}
          trailing={
            <ActionPill href={detailHref("receipt", item.receiptId)} ariaLabel={`Täydennä: ${item.party}`}>
              Täydennä
            </ActionPill>
          }
        />
      );
    case "missing_receipt":
      return (
        <ListRow
          key={item.id}
          href="/pankki/tapahtumat?nayta=toimet"
          leading={<Icon icon={Camera} />}
          title={item.party}
          amount={formatEur(Math.abs(item.amount))}
          amountTone={item.amount > 0 ? "positive" : "default"}
          secondary={item.date ? `Kuitti puuttuu · ${formatDayMonth(item.date)}` : "Kuitti puuttuu"}
          trailing={
            <ActionPill
              onClick={() => requestReceiptCapture({ transactionId: item.transactionId, label: item.party })}
              ariaLabel={`Kuvaa kuitti: ${item.party}`}
            >
              Kuvaa kuitti
            </ActionPill>
          }
        />
      );
    case "receipt_match":
      return (
        <ListRow
          key={item.id}
          href="/pankki/tapahtumat?nayta=toimet"
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
  const vatGapKinds: DashboardItemKind[] = ["vat_gap"];
  const bankKinds: DashboardItemKind[] = ["missing_receipt", "receipt_match", "invoice_match", "payment_duplicate"];
  const invoiceKinds: DashboardItemKind[] = ["draft_invoice"];

  const steps: Step[] = data
    ? [
        {
          key: "receipts",
          icon: Tag,
          title: "Kuitit",
          state: checkStepState(count(receiptKinds), data.receiptCount > 0),
          doneText: "Kaikki kuitit on hyväksytty",
          openText: `${plural(count(receiptKinds), "kuitti odottaa", "kuittia odottaa")} hyväksyntää`,
          noneText: "Ei kuitteja tässä kuussa",
          items: byKind(receiptKinds),
        },
        // F72: only when there is something to add (exceptions first).
        ...(count(vatGapKinds) > 0
          ? [
              {
                key: "vat",
                icon: Percent,
                title: "ALV-erittely",
                state: "open" as const,
                doneText: "",
                openText: `${plural(count(vatGapKinds), "kuitti", "kuittia")} ilman ALV-erittelyä`,
                noneText: "",
                items: byKind(vatGapKinds),
              },
            ]
          : []),
        {
          key: "bank",
          icon: ArrowLeftRight,
          title: "Pankkitapahtumat",
          // No tiliote means the rows cannot be checked: that is not "in order".
          state: checkStepState(count(bankKinds), data.hasStatement && data.progress.matchable > 0),
          doneText: `${data.progress.matched} / ${data.progress.matchable} pankkitapahtumaa kunnossa`,
          openText: `${plural(count(bankKinds), "pankkitapahtuma", "pankkitapahtumaa")} kesken`,
          noneText: data.hasStatement ? "Tiliotteella ei ole kirjattavia tapahtumia" : "Tiliotetta ei ole tuotu",
          items: byKind(bankKinds),
        },
        {
          key: "invoices",
          icon: FilePen,
          title: "Myyntilaskut",
          state: checkStepState(count(invoiceKinds), data.invoiceCount > 0),
          doneText: "Ei lähettämättömiä laskuja",
          openText: `${plural(count(invoiceKinds), "lasku", "laskua")} lähettämättä`,
          noneText: "Ei laskuja tässä kuussa",
          items: byKind(invoiceKinds),
        },
      ]
    : [];

  const vatState = vat.figures ? vatFilingState(vat.figures.filing) : null;
  // F66: a return whose figures moved after it was filed or paid is not done.
  const vatChanged = vatChangedSinceFiling(vat.figures);
  const vatDone =
    !vatChanged && (vatState === "paid" || (vatState === "filed" && vat.figures != null && vatNothingToPay(vat.figures)));
  const blocking = data?.blockingTotal ?? 0;
  const closeFacts = {
    ended: data?.ended ?? false,
    locked: data?.locked ?? false,
    blocking,
    hasContent: data?.hasContent ?? false,
    hasStatement: data?.hasStatement ?? false,
    vat:
      vat.due && vatState
        ? {
            state: vatState,
            done: vatDone,
            changedSinceFiling: vatChanged,
            nothingToPay: vat.figures != null && vatNothingToPay(vat.figures),
          }
        : null,
  };
  const closeButton = monthCloseButton(closeFacts);
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
      // The page may be showing an old lock; load the real one again.
      setAttempt((a) => a + 1);
    } finally {
      setClosing(false);
    }
  }

  const subtitle = data ? monthCloseSubtitle(closeFacts) : " ";

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
          {/* Not while the VAT figures are still loading: the verdict would flip. */}
          {monthCloseComplete(closeFacts) && !(vat.due && !vatState) ? <MonthDone month={month} name={name} /> : null}
          {steps.map((step) => (
            <Section key={step.key} title={step.title}>
              <ListRow
                leading={
                  <Icon
                    icon={step.state === "done" ? CircleCheck : step.state === "none" ? CircleDashed : Circle}
                    className={step.state === "done" ? "text-success" : "text-ink-2"}
                  />
                }
                title={stepText(step)}
                ariaLabel={`${step.title}: ${stepText(step)}`}
              />
              {step.items.map(itemRow)}
              {step.key === "bank" && !data.hasStatement ? (
                <ListRow
                  // F24: the picker opens from this tap, the file goes on to Pankki.
                  onClick={requestStatementImport}
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
              {vatChanged ? (
                <p className="px-4 pb-3 text-caption text-warning" role="note">
                  {vatChangedNote(vat.figures)}
                </p>
              ) : null}
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

          {/* F67: the way to Suljetut kaudet does not depend on which month is shown. */}
          <p className="px-1 text-caption text-ink-2">
            {data.locked ? "Suljetun kuukauden kuitteja, laskuja ja tapahtumia ei voi muuttaa. " : "Jo suljetut kaudet ja niiden avaaminen: "}
            <Link
              href="/kirjanpito/kaudet"
              className="relative font-medium text-accent before:absolute before:inset-x-0 before:-inset-y-3 before:content-['']"
            >
              Suljetut kaudet
            </Link>
          </p>

          {data.locked ? null : (
            <BottomActions>
              <Button
                className="w-full"
                busy={closing}
                busyLabel="Suljetaan…"
                disabled={closeButton.disabled}
                disabledReason={closeButton.reason}
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
              ...monthCloseWarnings(closeFacts),
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
