"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import StatementDetailView from "@/components/StatementDetailView";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import {
  apiFetch,
  errorMessage,
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
  const [loadError, setLoadError] = useState("");

  const loadStatement = useCallback(async () => {
    if (!statementId) {
      setStatement(null);
      setLoadError("");
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
      setLoadError("");
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
      setLoadError(errorMessage(error, "Tiliotteen lataus epäonnistui"));
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
      <div className="space-y-6 pb-6">
        {loadError ? (
          <ErrorState
            message={loadError}
            onRetry={() => {
              setLoadError("");
              setLoading(true);
              void loadStatement();
            }}
            compact
          />
        ) : loading ? (
          <LoadingState label="Ladataan tiliotetta..." compact />
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
