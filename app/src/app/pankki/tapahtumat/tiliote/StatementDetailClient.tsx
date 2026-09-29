"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import StatementDetailView from "@/components/StatementDetailView";
import { ErrorState } from "@/components/AsyncState";
import { StatementDetailSkeleton } from "@/components/books/Skeletons";
import {
  apiFetch,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import type { StatementData } from "@/lib/statement-client";
import { statementListHref } from "@/lib/navigation";
import { readPageCache, writePageCache } from "@/lib/page-cache";

export default function StatementDetailPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const statementId = searchParams.get("id") ?? "";
  const listHref = statementListHref(searchParams.toString());

  // Task 7-style instant paint: a cached copy renders immediately while
  // `loadStatement()` (below) confirms or refreshes it in the background.
  const cachedStatement = statementId ? readPageCache<StatementData>(`statement:${statementId}`) : null;
  const [statement, setStatement] = useState<StatementData | null>(cachedStatement);
  const [loading, setLoading] = useState(!cachedStatement);
  const [loadError, setLoadError] = useState<unknown>(null);

  const loadStatement = useCallback(async () => {
    if (!statementId) {
      setStatement(null);
      setLoadError(null);
      setLoading(false);
      return;
    }
    try {
      const res = await apiFetch(`/api/statements/${statementId}`);
      const data = await readJson<{ statement?: StatementData }>(
        res,
        "Tiliotteen lataus epäonnistui"
      );
      setStatement(data.statement ?? null);
      setLoadError(null);
      if (data.statement) writePageCache(`statement:${statementId}`, data.statement);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      // A cached copy already on screen (readPageCache above) stays up
      // rather than being replaced by the error screen -- only a
      // statement never seen before goes to the error state.
      if (readPageCache<StatementData>(`statement:${statementId}`)) return;
      // The error object: ConnectionNotice words it in Finnish (BOOKS-15).
      setLoadError(error);
      setStatement(null);
    } finally {
      setLoading(false);
    }
  }, [statementId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void loadStatement();
  }, [loadStatement]);

  return (
    <>
      <div className="space-y-6">
        {loadError != null ? (
          <ErrorState
            error={loadError}
            message="Tiliotteen lataus epäonnistui"
            onRetry={() => {
              setLoadError(null);
              setLoading(true);
              void loadStatement();
            }}
            compact
          />
        ) : loading ? (
          <StatementDetailSkeleton />
        ) : !statement ? (
          <div className="text-center py-8 text-[15px] text-ink-2">
            Tiliotetta ei löytynyt
          </div>
        ) : (
          <StatementDetailView
            statement={statement}
            onStatementUpdated={setStatement}
            onDeleted={() => router.push(listHref)}
          />
        )}
      </div>
    </>
  );
}
