"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import StatementDetailView from "@/components/StatementDetailView";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import {
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import type { StatementData } from "@/lib/statement-client";

export default function StatementDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const statementId = params.id;

  const [statement, setStatement] = useState<StatementData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const loadStatement = useCallback(async () => {
    try {
      const res = await fetch(`/api/statements/${statementId}`);
      const data = await readJson<{ statement?: StatementData }>(
        res,
        "Tiliotteen lataus epäonnistui"
      );
      setStatement(data.statement ?? null);
      setLoadError("");
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setLoadError(errorMessage(error, "Tiliotteen lataus epäonnistui"));
      setStatement(null);
    } finally {
      setLoading(false);
    }
  }, [statementId]);

  useEffect(() => {
    void loadStatement();
  }, [loadStatement]);

  return (
    <AppShell>
      <div className="space-y-6 pb-6">
        <Link
          href="/tiliotteet"
          className="inline-flex items-center gap-2 text-sm font-medium text-accent hover:text-accent-dark transition-colors px-1"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          Takaisin tiliotteisiin
        </Link>

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
          <div className="text-center py-8 text-sm text-warm-gray">
            Tiliotetta ei löytynyt
          </div>
        ) : (
          <StatementDetailView
            statement={statement}
            onStatementUpdated={setStatement}
            onDeleted={() => router.push("/tiliotteet")}
          />
        )}
      </div>
    </AppShell>
  );
}
