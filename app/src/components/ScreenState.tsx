"use client";

import { Button } from "@/components/ui";
import { redirectToLogin } from "@/components/clientFetch";
import {
  CONNECTION_COPY,
  classifyConnection,
  emptyKind,
  formatUpdatedAt,
  type EmptyKind,
} from "@/lib/screen-state";

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
          body: error instanceof Error && error.message ? error.message : fallback,
        }
      : CONNECTION_COPY[kind];

  return (
    <div
      className={`rounded-2xl border text-sm ${
        kind === "expired"
          ? "border-warning/40 bg-warning/10 text-charcoal"
          : kind === "offline"
            ? "border-line bg-surface text-ink"
            : kind === "unreachable"
              ? "border-accent/30 bg-blush/40 text-charcoal"
              : "border-danger/30 bg-danger/10 text-danger"
      } ${compact ? "p-4" : "p-6"}`}
      role="alert"
      data-connection={kind}
    >
      <p className="font-medium">{copy.title}</p>
      <p className={`mt-1 leading-relaxed ${kind === "generic" ? "" : "text-charcoal/80"}`}>
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
      className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-charcoal"
      role="status"
      data-stale="true"
    >
      <p>{label}. Näytetään tallennettu versio.</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-11 px-3 rounded-xl bg-surface border border-warning/40 font-medium"
        >
          Yritä uudelleen
        </button>
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
    <div className="text-center py-8 space-y-3" data-empty={kind}>
      <p className="text-sm font-medium text-charcoal">{title ?? copy.title}</p>
      <p className="text-sm text-warm-gray">{body ?? copy.body}</p>
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
