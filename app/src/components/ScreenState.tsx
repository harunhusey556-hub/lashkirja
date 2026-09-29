"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { CloudOff, Inbox, Lock, SearchX, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui";
import { buttonClass } from "@/components/control-styles";
import { Icon } from "@/components/ds/Icon";
import { errorMessage, redirectToLogin } from "@/components/clientFetch";
import { claimConnectionNotice } from "@/lib/connection-notice";
import { retryConnection, useConnectivity } from "@/lib/connectivity";
import {
  CONNECTION_COPY,
  ERROR_TITLE,
  STALE_COPY,
  classifyConnection,
  emptyKind,
  formatUpdatedAt,
  type EmptyKind,
} from "@/lib/screen-state";

/**
 * The state patterns (VS-30..33, spec 2.9). One of each, everywhere:
 *
 * - Empty:   `EmptyState` (56 px tile, "Ei X vielä", one sentence, at most one
 *            primary action) and `EmptyNote` for a section that is empty inside
 *            a populated screen.
 * - Error:   `ConnectionNotice` in the place of the content, ONE retry, the title
 *            "Jotain meni pieleen". Outside the shell: `FullScreenNotice`.
 * - Offline: the overlay `ConnectivityBanner`, or, when a page has its own card,
 *            `ConnectionNotice` (nothing to show) / `StaleBanner` (saved copy on
 *            screen). While one of those is mounted the banner stays quiet.
 * - Loading: a `ds/Skeleton` at the final layout (`SkeletonList` in AsyncState).
 */

/**
 * The shared failure card (L3, L4): classifies `error` as offline,
 * unreachable, expired session or a generic failure, shows Finnish copy only,
 * and offers ONE "Yritä uudelleen" when `onRetry` is given (or "Kirjaudu sisään"
 * for an expired session). Use it for every load failure, in the place of the
 * content it failed to load; `ErrorState` in AsyncState is the same card for
 * callers that only have a message. Never nest it in another card and never
 * show a second one beside it.
 */
export function ConnectionNotice({
  error,
  fallback = "Lataus epäonnistui",
  onRetry,
  title,
  compact = false,
}: {
  error: unknown;
  fallback?: string;
  onRetry?: () => void;
  /** Overrides the generic title for a failure that has its own words ("Kuittia ei löytynyt"). */
  title?: string;
  /** Kept for callers; every failure card has the same 16 px padding (R3). */
  compact?: boolean;
}) {
  void compact;
  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  const kind = classifyConnection(error, online);
  const copy =
    kind === "generic"
      ? {
          title: title ?? ERROR_TITLE,
          // Never the raw server/network string (L5): errorMessage maps it.
          body: errorMessage(error, fallback),
        }
      : CONNECTION_COPY[kind];

  // The card owns the "no connection" message: the global banner steps aside so
  // the screen has one message and one retry (FP-14).
  const ownsConnection = kind === "offline" || kind === "unreachable";
  useEffect(() => (ownsConnection ? claimConnectionNotice() : undefined), [ownsConnection]);
  const retry = onRetry ?? (kind === "unreachable" ? () => void retryConnection() : undefined);

  return (
    <div
      className={`rounded-card border p-4 ${
        kind === "expired"
          ? "border-warning/40 bg-warning/10 text-ink"
          : kind === "offline"
            ? "border-line bg-surface text-ink"
            : kind === "unreachable"
              ? "border-accent/30 bg-accent-soft text-ink"
              : "border-danger/30 bg-danger/10 text-danger"
      }`}
      role="alert"
      data-connection={kind}
    >
      <p className="text-body font-semibold">{copy.title}</p>
      <p className={`mt-1 text-body leading-relaxed ${kind === "generic" ? "" : "text-ink-2"}`}>{copy.body}</p>
      {kind === "expired" ? (
        <Button type="button" className="mt-3" onClick={() => redirectToLogin()}>
          Kirjaudu sisään
        </Button>
      ) : (
        retry && (
          <Button type="button" variant="secondary" className="mt-3" onClick={retry}>
            Yritä uudelleen
          </Button>
        )
      )}
    </div>
  );
}

/**
 * The rest of the screen loaded but some parts did not (Koti): ONE failure card that names
 * what is missing, with ONE retry, instead of a card and a retry button per part. The failed
 * parts themselves are simply left out.
 */
export function PartialFailureNotice({ messages, onRetry }: { messages: string[]; onRetry?: () => void }) {
  const unique = [...new Set(messages.filter(Boolean))];
  if (unique.length === 0) return null;
  return (
    <div className="rounded-card border border-danger/30 bg-danger/10 p-4 text-danger" role="alert" data-connection="partial">
      <p className="text-body font-semibold">{ERROR_TITLE}</p>
      <ul className="mt-1 space-y-0.5 text-body leading-relaxed">
        {unique.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
      {onRetry && (
        <Button type="button" variant="secondary" className="mt-3" onClick={onRetry}>
          Yritä uudelleen
        </Button>
      )}
    </div>
  );
}

/**
 * A saved copy is on screen and the latest refresh failed. Says why in the
 * shared words ("… Näytetään viimeksi haetut tiedot."), when the copy is from,
 * and offers the one retry. Takes over the connection message from the global
 * banner while it is mounted.
 */
export function StaleBanner({
  fetchedAt,
  onRetry,
}: {
  fetchedAt: number | null;
  onRetry?: () => void;
}) {
  const { device, server } = useConnectivity();
  const kind = device === "offline" ? "offline" : server === "unreachable" ? "unreachable" : "failed";
  const ownsConnection = kind !== "failed";
  useEffect(() => (ownsConnection ? claimConnectionNotice() : undefined), [ownsConnection]);
  const updated = fetchedAt == null ? "Viimeksi päivitetty aiemmin" : formatUpdatedAt(fetchedAt);
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-card border border-line bg-surface p-4"
      role="status"
      data-stale="true"
    >
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-body font-medium text-ink">{STALE_COPY[kind]}</p>
        <p className="mt-0.5 text-caption text-ink-2">{updated}.</p>
      </div>
      {onRetry && (
        <Button type="button" variant="secondary" onClick={onRetry}>
          Yritä uudelleen
        </Button>
      )}
    </div>
  );
}

/**
 * The notice card of a page outside the app shell: a 56 px tile, the title (17/600), one
 * sentence and the page's own actions as `children`. `FullScreenNotice` puts it on its own
 * canvas; the bare recovery pages use it inside `BareFrame`.
 */
export function NoticeCard({
  icon,
  title = ERROR_TITLE,
  body,
  tone = "accent",
  children,
}: {
  icon: LucideIcon;
  title?: string;
  body: string;
  tone?: "accent" | "danger" | "warning";
  children?: ReactNode;
}) {
  return (
    <div className="w-full max-w-sm rounded-card border border-line bg-surface p-6 text-center" role="alert">
      <div
        className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full ${
          tone === "danger"
            ? "bg-danger/10 text-danger"
            : tone === "warning"
              ? "bg-warning/10 text-warning"
              : "bg-accent-soft text-accent"
        }`}
      >
        <Icon icon={icon} size="hero" />
      </div>
      <h1 className="text-headline font-semibold text-ink">{title}</h1>
      <p className="mt-2 text-body text-ink-2">{body}</p>
      {children}
    </div>
  );
}

/**
 * The failure card for a page outside the app shell (bank callback, `error.tsx`,
 * `not-found.tsx`): the same tile, title and wording, on its own canvas, with one action.
 */
export function FullScreenNotice({
  icon,
  title,
  body,
  actionLabel,
  onAction,
  href,
  tone = "accent",
}: {
  icon: LucideIcon;
  title?: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  href?: string;
  tone?: "accent" | "danger";
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <NoticeCard icon={icon} title={title} body={body} tone={tone}>
        {href && actionLabel ? (
          <Link href={href} className={`mt-5 w-full ${buttonClass("primary")}`}>
            {actionLabel}
          </Link>
        ) : onAction && actionLabel ? (
          <button type="button" onClick={onAction} className={`mt-5 w-full ${buttonClass("primary")}`}>
            {actionLabel}
          </button>
        ) : null}
      </NoticeCard>
    </main>
  );
}

const EMPTY_COPY: Record<EmptyKind, { title: string; body: string }> = {
  records: {
    title: "Ei tietoja vielä",
    body: "Tämä lista on tyhjä, kunnes lisäät ensimmäisen.",
  },
  filtered: {
    title: "Ei osumia",
    body: "Yksikään rivi ei vastaa nykyisiä suodattimia.",
  },
  failed: {
    title: ERROR_TITLE,
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

/**
 * The one empty pattern (VS-30): a 56 px tile with the object's icon, a title
 * "Ei X vielä" (17/600), one 15 px sentence, and at most ONE primary action, which
 * carries the same label as the screen's header pill (R19). The page hides its
 * filters, search field and zero tables while there is no data at all.
 * `filtered` (nothing matches the filter or search) offers a quiet reset, not a
 * primary.
 */
export function EmptyState({
  kind,
  title,
  body,
  icon,
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
  /** The object's own glyph (Receipt for Kuitit), instead of the generic inbox. */
  icon?: LucideIcon;
  onCreate?: () => void;
  createLabel?: string;
  onClear?: () => void;
  clearLabel?: string;
  onRetry?: () => void;
  action?: ReactNode;
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
        <Icon icon={icon ?? EMPTY_ICON[kind]} size="hero" />
      </span>
      <div className="space-y-1">
        <p className="text-headline font-semibold text-ink">{title ?? copy.title}</p>
        <p className="mx-auto max-w-xs text-body leading-relaxed text-ink-2">{body ?? copy.body}</p>
      </div>
      {kind === "records" && (onCreate || action) && (
        <div className="pt-1">
          {onCreate ? (
            <Button type="button" onClick={onCreate}>
              {createLabel}
            </Button>
          ) : (
            action
          )}
        </div>
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

/**
 * A section that is empty inside a populated screen: one line in a card,
 * "Ei X vielä." with a period (2.9). Not for a whole empty screen.
 */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4 text-body text-ink-2" data-empty="note">
      {children}
    </div>
  );
}

/** `EmptyNote` under a section heading of its own (same heading style as `ds/Section`). */
export function EmptySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <h2 className="mb-2 px-1 text-caption font-normal text-ink-2">{title}</h2>
      <EmptyNote>{children}</EmptyNote>
    </section>
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
