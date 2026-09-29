"use client";

import { CloudOff, Inbox, Lock, SearchX, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui";
import { Icon } from "@/components/ds/Icon";
import { errorMessage, redirectToLogin } from "@/components/clientFetch";
import {
  CONNECTION_COPY,
  classifyConnection,
  emptyKind,
  formatUpdatedAt,
  type EmptyKind,
} from "@/lib/screen-state";

/**
 * The shared failure card (L3, L4): classifies `error` as offline,
 * unreachable, expired session or a generic failure, shows Finnish copy only,
 * and offers "Yritä uudelleen" when `onRetry` is given (or "Kirjaudu sisään"
 * for an expired session). Use it for every load failure; `ErrorState` in
 * AsyncState is the same card for callers that only have a message.
 */
export function ConnectionNotice({
  error,
  fallback = "Lataus epäonnistui",
  onRetry,
  compact = false,
}: {
  error: unknown;
  fallback?: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  const kind = classifyConnection(error, online);
  const copy =
    kind === "generic"
      ? {
          title: "Jotain meni pieleen",
          // Never the raw server/network string (L5): errorMessage maps it.
          body: errorMessage(error, fallback),
        }
      : CONNECTION_COPY[kind];

  return (
    <div
      className={`rounded-card border text-sm ${
        kind === "expired"
          ? "border-warning/40 bg-warning/10 text-ink"
          : kind === "offline"
            ? "border-line bg-surface text-ink"
            : kind === "unreachable"
              ? "border-accent/30 bg-accent-soft text-ink"
              : "border-danger/30 bg-danger/10 text-danger"
      } ${compact ? "p-4" : "p-6"}`}
      role="alert"
      data-connection={kind}
    >
      <p className="font-medium">{copy.title}</p>
      <p className={`mt-1 leading-relaxed ${kind === "generic" ? "" : "text-ink-2"}`}>
        {copy.body}
      </p>
      {kind === "expired" ? (
        <Button type="button" className="mt-3" onClick={() => redirectToLogin()}>
          Kirjaudu sisään
        </Button>
      ) : (
        onRetry && (
          <Button type="button" variant="secondary" className="mt-3" onClick={onRetry}>
            Yritä uudelleen
          </Button>
        )
      )}
    </div>
  );
}

export function StaleBanner({
  fetchedAt,
  onRetry,
}: {
  fetchedAt: number | null;
  onRetry?: () => void;
}) {
  const label = fetchedAt == null ? "Viimeksi päivitetty aiemmin" : formatUpdatedAt(fetchedAt);
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-ink"
      role="status"
      data-stale="true"
    >
      <p>{label}. Näytetään tallennettu versio.</p>
      {onRetry && (
        <Button type="button" variant="secondary" onClick={onRetry}>
          Yritä uudelleen
        </Button>
      )}
    </div>
  );
}

const EMPTY_COPY: Record<
  EmptyKind,
  { title: string; body: string }
> = {
  records: {
    title: "Ei tietoja vielä",
    body: "Tämä lista on tyhjä, kunnes lisäät ensimmäisen.",
  },
  filtered: {
    title: "Ei osumia",
    body: "Yksikään rivi ei vastaa nykyisiä suodattimia.",
  },
  failed: {
    title: "Lataus epäonnistui",
    body: "Tietoja ei saatu haettua.",
  },
  forbidden: {
    title: "Ei käyttöoikeutta",
    body: "Tähän näkymään ei ole oikeutta.",
  },
};

const EMPTY_ICON: Record<EmptyKind, LucideIcon> = {
  records: Inbox,
  filtered: SearchX,
  failed: CloudOff,
  forbidden: Lock,
};

export function EmptyState({
  kind,
  title,
  body,
  onCreate,
  createLabel = "Lisää",
  onClear,
  clearLabel = "Tyhjennä suodattimet",
  onRetry,
  action,
}: {
  kind: EmptyKind;
  title?: string;
  body?: string;
  onCreate?: () => void;
  createLabel?: string;
  onClear?: () => void;
  clearLabel?: string;
  onRetry?: () => void;
  action?: React.ReactNode;
}) {
  const copy = EMPTY_COPY[kind];
  return (
    <div className="flex flex-col items-center space-y-3 px-4 py-10 text-center" data-empty={kind}>
      <span
        aria-hidden
        className={`flex h-14 w-14 items-center justify-center rounded-full ${
          kind === "failed" ? "bg-danger/10 text-danger" : "border border-line bg-surface text-ink-2"
        }`}
      >
        <Icon icon={EMPTY_ICON[kind]} size="hero" />
      </span>
      <div className="space-y-1">
        <p className="text-body font-semibold text-ink">{title ?? copy.title}</p>
        <p className="mx-auto max-w-xs text-caption leading-relaxed text-ink-2">{body ?? copy.body}</p>
      </div>
      {kind === "records" && action}
      {kind === "records" && onCreate && (
        <Button type="button" onClick={onCreate}>
          {createLabel}
        </Button>
      )}
      {kind === "filtered" && onClear && (
        <Button type="button" variant="secondary" onClick={onClear}>
          {clearLabel}
        </Button>
      )}
      {kind === "failed" && onRetry && (
        <Button type="button" variant="secondary" onClick={onRetry}>
          Yritä uudelleen
        </Button>
      )}
    </div>
  );
}

export function listEmptyKind(
  count: number,
  hasActiveFilter: boolean,
  failed = false,
  forbidden = false
): EmptyKind | null {
  return emptyKind({ count, hasActiveFilter, failed, forbidden });
}
