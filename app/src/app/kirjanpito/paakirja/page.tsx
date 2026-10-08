"use client";

import { useEffect, useState } from "react";
import { apiFetch, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { Card, FilterChips, PageTitle, Section, SkeletonCard } from "@/components/ds";
import { ConnectionNotice } from "@/components/ScreenState";
import { formatEur } from "@/lib/format";
import { useRefetchOnReconnect } from "@/components/useRefetchOnReconnect";

/**
 * Kirjanpito (pääkirja): the double-entry books of one fiscal year, derived
 * from the documents (/api/ledger). Read only; the CSV files are for the accountant.
 */

interface Line {
  code: string;
  name: string;
  cents: number;
}

interface Books {
  year: number;
  journal: Array<{ voucher: number; id: string; date: string; description: string; lines: Array<{ account: string; debitCents: number; creditCents: number }> }>;
  trialBalance: Array<{ code: string; name: string; debitCents: number; creditCents: number; balanceCents: number }>;
  incomeStatement: { revenue: Line[]; expenses: Line[]; revenueCents: number; expensesCents: number; resultCents: number };
  balanceSheet: { assets: Line[]; liabilities: Line[]; equity: Line[]; assetsCents: number; liabilitiesAndEquityCents: number };
  notes: { openingBalanceMissing: boolean; suspenseCents: number; balances: boolean };
}

type View = "tulos" | "tase" | "saldo" | "paivakirja";

const VIEWS: Array<{ id: View; label: string }> = [
  { id: "tulos", label: "Tuloslaskelma" },
  { id: "tase", label: "Tase" },
  { id: "saldo", label: "Saldoluettelo" },
  { id: "paivakirja", label: "Päiväkirja" },
];

const eur = (cents: number) => formatEur(cents / 100);

function Row({ code, name, cents, strong = false }: { code?: string; name: string; cents: number; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 py-1.5 ${strong ? "font-semibold" : ""}`}>
      <span className="min-w-0 text-body text-ink">
        {code ? <span className="mr-2 tabular-nums text-ink-2">{code}</span> : null}
        {name}
      </span>
      <span className="shrink-0 tabular-nums text-body text-ink">{eur(cents)}</span>
    </div>
  );
}

export default function LedgerPage() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [view, setView] = useState<View>("tulos");
  // Kept with its year: a year switch shows the skeleton until that year's books arrive.
  const [result, setResult] = useState<{ year: number; books: Books } | null>(null);
  const books = result?.year === year ? result.books : null;
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useRefetchOnReconnect(() => setAttempt((value) => value + 1));

  useEffect(() => {
    const controller = new AbortController();
    apiFetch(`/api/ledger?year=${year}`, { signal: controller.signal })
      .then((response) => readJson<Books>(response, "Kirjanpidon lataus epäonnistui"))
      .then((data) => {
        if (controller.signal.aborted) return;
        setError(null);
        setResult({ year, books: data });
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(failure)) {
          redirectToLogin();
          return;
        }
        setError(failure);
      });
    return () => controller.abort();
  }, [year, attempt]);

  const years = [thisYear, thisYear - 1, thisYear - 2].map((value) => ({ id: String(value), label: String(value) }));

  return (
    <div className="space-y-5">
      <PageTitle title="Kirjanpito" subtitle="Tuloslaskelma, tase ja tositteet kahdenkertaisena kirjanpitona" />
      <FilterChips label="Tilikausi" items={years} value={String(year)} onChange={(id) => setYear(Number(id))} />
      <FilterChips label="Näkymä" items={VIEWS} value={view} onChange={setView} wrap />

      {error && !books ? <ConnectionNotice error={error} onRetry={() => setAttempt((value) => value + 1)} /> : null}
      {!books && !error ? <SkeletonCard /> : null}

      {books ? (
        <>
          {!books.notes.balances ? (
            <p className="text-body text-danger">Tase ei täsmää. Ilmoita tästä tukeen.</p>
          ) : null}
          <Card className="space-y-1">
            {books.notes.openingBalanceMissing ? (
              <p className="text-caption text-ink-2">
                Kirjanpito alkaa ensimmäisestä tositteesta: avaavaa tasetta ei ole vielä kirjattu, joten pankkitilin ja
                oman pääoman saldot eivät sisällä aiempia vuosia.
              </p>
            ) : null}
            {books.notes.suspenseCents > 0 ? (
              <p className="text-caption text-warning">
                {`${eur(books.notes.suspenseCents)} ostoja ei ole maksettu yritystililtä (selvittelytili 2990). Kohdista kuitit pankkitapahtumiin tai kirjaa ne omilla varoilla maksetuiksi.`}
              </p>
            ) : null}
            <p className="text-caption text-ink-2">
              ALV:n maksut verottajalle eivät vielä näy kirjanpidossa, joten ALV-tilit näyttävät koko kauden kertymän.
            </p>
          </Card>

          {view === "tulos" ? (
            <Section title={`Tuloslaskelma ${books.year}`}>
              <Card>
                {books.incomeStatement.revenue.map((line) => <Row key={line.code} {...line} />)}
                <Row name="Tuotot yhteensä" cents={books.incomeStatement.revenueCents} strong />
                <div className="my-2 border-t border-line" />
                {books.incomeStatement.expenses.map((line) => <Row key={line.code} {...line} />)}
                <Row name="Kulut yhteensä" cents={books.incomeStatement.expensesCents} strong />
                <div className="my-2 border-t border-line" />
                <Row name="Tilikauden tulos" cents={books.incomeStatement.resultCents} strong />
              </Card>
            </Section>
          ) : null}

          {view === "tase" ? (
            <Section title={`Tase 31.12.${books.year}`}>
              <Card>
                <p className="text-caption font-semibold text-ink-2">Vastaavaa</p>
                {books.balanceSheet.assets.map((line) => <Row key={line.code} {...line} />)}
                <Row name="Vastaavaa yhteensä" cents={books.balanceSheet.assetsCents} strong />
                <div className="my-2 border-t border-line" />
                <p className="text-caption font-semibold text-ink-2">Vastattavaa</p>
                {books.balanceSheet.equity.map((line) => <Row key={line.code} {...line} />)}
                {books.balanceSheet.liabilities.map((line) => <Row key={line.code} {...line} />)}
                <Row name="Vastattavaa yhteensä" cents={books.balanceSheet.liabilitiesAndEquityCents} strong />
              </Card>
            </Section>
          ) : null}

          {view === "saldo" ? (
            <Section title={`Saldoluettelo ${books.year}`}>
              <Card>
                {books.trialBalance.map((row) => (
                  <Row key={row.code} code={row.code} name={row.name} cents={row.balanceCents} />
                ))}
                <p className="pt-2 text-caption text-ink-2">Saldo = debet − kredit.</p>
              </Card>
            </Section>
          ) : null}

          {view === "paivakirja" ? (
            <Section title={`Päiväkirja ${books.year}`} count={books.journal.length}>
              <div className="space-y-2">
                {books.journal.length === 0 ? <p className="text-body text-ink-2">Ei tositteita tällä tilikaudella.</p> : null}
                {books.journal.map((entry) => (
                  <Card key={entry.id}>
                    <p className="text-caption text-ink-2">{`Tosite ${entry.voucher} · ${entry.date.split("-").reverse().join(".")}`}</p>
                    <p className="text-body text-ink">{entry.description}</p>
                    {entry.lines.map((line) => (
                      <div key={line.account} className="flex justify-between gap-3 text-caption tabular-nums text-ink-2">
                        <span>{line.account}</span>
                        <span>{line.debitCents ? `Debet ${eur(line.debitCents)}` : `Kredit ${eur(line.creditCents)}`}</span>
                      </div>
                    ))}
                  </Card>
                ))}
              </div>
            </Section>
          ) : null}

          <Section title="Muistio tilitoimistolle">
            <Card className="flex flex-wrap gap-4">
              <a className="text-body text-accent underline" href={`/api/ledger/export?year=${books.year}&report=paivakirja`}>
                Päiväkirja (CSV)
              </a>
              <a className="text-body text-accent underline" href={`/api/ledger/export?year=${books.year}&report=saldoluettelo`}>
                Saldoluettelo (CSV)
              </a>
            </Card>
          </Section>
        </>
      ) : null}
    </div>
  );
}
