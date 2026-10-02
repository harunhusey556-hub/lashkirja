"use client";

import { AnimatedRows } from "@/components/AnimatedRows";
import { useCallback, useEffect, useMemo, useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import { ErrorState } from "@/components/AsyncState";
import { apiFetch, leaveAfterSignOut, readJson } from "@/components/clientFetch";
import { Card, PageTitle, Skeleton, SkeletonCard, SkeletonGroup, useSkeletonFade } from "@/components/ds";
import { Button } from "@/components/ui";
import { hapticNotify } from "@/lib/haptics";
import { showToast } from "@/lib/toast";
import { tintedButtonClass } from "@/components/control-styles";

interface SessionRow {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

/** Other devices shown before "Näytä kaikki": the demo account has 100+ rows. */
const VISIBLE_OTHERS = 5;

type Pending = { kind: "one"; id: string } | { kind: "others" } | null;

function formatLastSeen(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "Käyttöaika tuntematon";
  const yearOf = (value: number) =>
    new Date(value).toLocaleString("fi-FI", { timeZone: "Europe/Helsinki", year: "numeric" });
  // The year only when it is not this one: the full stamp wrapped to two
  // lines beside the "Kirjaa ulos" pill on a phone.
  const date = new Date(time).toLocaleString("fi-FI", {
    timeZone: "Europe/Helsinki",
    day: "numeric",
    month: "numeric",
    ...(yearOf(time) === yearOf(Date.now()) ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Käytetty ${date}`;
}

export default function LaitteetPage() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [showAll, setShowAll] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const fade = useSkeletonFade(sessions === null && failure === null);

  const load = useCallback(async () => {
    setFailure(null);
    try {
      const response = await apiFetch("/api/auth/sessions");
      const data = await readJson<{ sessions: SessionRow[] }>(response, "Istuntoja ei saatu ladattua");
      setSessions(data.sessions);
    } catch (error: unknown) {
      setFailure(error ?? new Error("load"));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: the session list is an external source this effect syncs
    void load();
  }, [load]);

  const { current, others } = useMemo(() => {
    const rows = sessions ?? [];
    return {
      current: rows.find((row) => row.current) ?? null,
      others: rows
        .filter((row) => !row.current)
        .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()),
    };
  }, [sessions]);

  async function revoke(body: { scope?: "others" | "all"; id?: string }) {
    const response = await apiFetch("/api/auth/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await readJson<{ signedOut: boolean }>(response, "Istunnon sulkeminen epäonnistui");
    if (data.signedOut) {
      const left = await leaveAfterSignOut();
      if (!left) throw new Error("Uloskirjautuminen epäonnistui. Istunto voi olla yhä voimassa.");
      return;
    }
    setSessions((rows) =>
      (rows ?? []).filter((row) => (body.id ? row.id !== body.id : row.current))
    );
    void hapticNotify("success");
    showToast({
      tone: "success",
      text: body.id ? "Laite suljettu." : "Muut laitteet suljettu.",
      haptic: false,
    });
  }

  if (failure !== null) {
    return (
      <div className="space-y-6">
        <PageTitle title="Laitteet" />
        <ErrorState error={failure} message="Istuntoja ei saatu ladattua" onRetry={() => void load()} />
      </div>
    );
  }

  if (sessions === null) {
    return (
      <div className="space-y-6">
        <PageTitle title="Laitteet" />
        <SkeletonGroup label="Ladataan laitteita">
          <SkeletonCard className="space-y-4">
            {[0, 1, 2].map((row) => (
              <div key={row} className="space-y-2">
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="h-3 w-3/5" tone="soft" />
              </div>
            ))}
          </SkeletonCard>
        </SkeletonGroup>
      </div>
    );
  }

  const visibleOthers = showAll ? others : others.slice(0, VISIBLE_OTHERS);

  return (
    <div className={`space-y-6 ${fade}`.trim()}>
      <PageTitle title="Laitteet" />
      <Card className="space-y-3">
        <p className="text-caption text-ink-2">
          Lista näyttää kirjautumiset, joissa istunto on tallennettu. Vanha selain ilman tunnistetta pysyy, kunnes kirjaat laitteen ulos.
        </p>

        {current && (
          <div className="flex items-center gap-3 rounded-card bg-canvas px-3 py-3">
            <span className="min-w-0 flex-1">
              <span className="block clamp-lines [overflow-wrap:anywhere] text-body font-medium text-ink">{current.label}</span>
              <span className="block text-caption text-ink-2">Tämä laite</span>
            </span>
          </div>
        )}

        {others.length > 0 ? (
          <>
            <Button type="button" variant="secondary" className="w-full" onClick={() => setPending({ kind: "others" })}>
              Kirjaa muut laitteet ulos ({others.length})
            </Button>
            <div role="list" className="divide-y divide-line">
              <AnimatedRows rows={visibleOthers.map((row) => ({ key: row.id, node: (
                <div role="listitem" key={row.id} className="flex items-center gap-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block clamp-lines [overflow-wrap:anywhere] text-body text-ink">{row.label}</span>
                    <span className="block text-caption text-ink-2">{formatLastSeen(row.lastSeenAt)}</span>
                  </span>
                  <button
                    type="button"
                    className={tintedButtonClass("danger", "shrink-0")}
                    onClick={() => setPending({ kind: "one", id: row.id })}
                    aria-label={`Kirjaa ulos: ${row.label}`}
                  >
                    Kirjaa ulos
                  </button>
                </div>
              ) }))} />
            </div>
            {others.length > VISIBLE_OTHERS && (
              <button
                type="button"
                className={tintedButtonClass("accent", "w-full")}
                onClick={() => setShowAll((value) => !value)}
              >
                {showAll ? "Näytä vähemmän" : `Näytä kaikki (${others.length})`}
              </button>
            )}
          </>
        ) : (
          <p className="py-2 text-body text-ink-2">Ei muita kirjautuneita laitteita.</p>
        )}
      </Card>

      <ConfirmModal
        isOpen={pending !== null}
        title={pending?.kind === "others" ? "Kirjataanko muut laitteet ulos?" : "Kirjataanko laite ulos?"}
        description={
          pending?.kind === "others"
            ? "Kaikki muut laitteet kirjataan ulos ja kaikki pääsyavaimet poistetaan, myös tämän laitteen. Tämä laite pysyy kirjautuneena salasanalla."
            : "Laite kirjataan ulos. Se voi kirjautua uudelleen salasanalla."
        }
        confirmLabel="Kirjaa ulos"
        onConfirm={async () => {
          if (!pending) return;
          await revoke(pending.kind === "others" ? { scope: "others" } : { id: pending.id });
          setPending(null);
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
