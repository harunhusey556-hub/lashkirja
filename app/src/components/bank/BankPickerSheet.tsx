"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ChevronRight, Landmark, Search } from "lucide-react";
import BottomSheet from "@/components/BottomSheet";
import { Icon } from "@/components/ds";
import { Button } from "@/components/ui";
import { Skeleton, SkeletonGroup } from "@/components/ds/Skeleton";
import { ConnectionNotice, EmptyState } from "@/components/ScreenState";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { useProfile } from "@/app/asetukset/useProfile";
import { leaveForBank } from "@/lib/open-bank-auth";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { hapticSelection } from "@/lib/haptics";
import { tintedButtonClass } from "@/components/control-styles";

interface Aspsp {
  name: string;
  country: string;
  logo: string | null;
  psuTypes: string[];
  beta: boolean;
}

type PsuType = "business" | "personal";

interface HistoryChoice {
  key: string;
  label: string;
  hint?: string;
  /** "YYYY-MM-DD", or null for everything the bank allows. */
  from: string | null;
}

function isoDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Mistä lähtien haetaan?": the first sync used to pull the bank's whole history. */
export function historyChoices(now = new Date()): HistoryChoice[] {
  const year = now.getFullYear();
  return [
    { key: "month", label: "Tämä kuukausi", from: isoDay(new Date(year, now.getMonth(), 1)) },
    { key: "year", label: `Vuoden ${year} alusta`, hint: "Suositus", from: `${year}-01-01` },
    { key: "12m", label: "Viimeiset 12 kuukautta", from: isoDay(new Date(year, now.getMonth() - 11, 1)) },
    { key: "all", label: "Kaikki, mitä pankki antaa", hint: "Voi olla useita vuosia", from: null },
  ];
}

/**
 * The bank list (BOOKS-06): a sheet with one scroller. The account type and
 * the search stay above the list; tapping a bank hands over to the bank's own
 * login (`leaveForBank`), and the existing `bank-return` path brings the user
 * back. The profile only preselects the account type (BOOKS-07): a profile
 * that fails to load never blocks connecting.
 */
export default function BankPickerSheet({
  isOpen,
  onClose,
  preferredPsu,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Reconnect keeps the connection's own type. */
  preferredPsu?: PsuType;
}) {
  const titleId = useId();
  const { profile } = useProfile();
  const profilePsu: PsuType = profile?.entityType === "kevytyrittaja" ? "personal" : "business";
  const [psuChoice, setPsuChoice] = useState<PsuType | null>(null);
  const psuType = psuChoice ?? preferredPsu ?? profilePsu;
  const [banks, setBanks] = useState<{ psu: PsuType; list: Aspsp[] } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [busyBank, setBusyBank] = useState<string | null>(null);
  const [connectError, setConnectError] = useState("");
  const [chosenBank, setChosenBank] = useState<Aspsp | null>(null);
  const choices = useMemo(() => historyChoices(), []);
  const [historyKey, setHistoryKey] = useState("year");

  // A fresh sheet every time it opens: no leftover search or error.
  const [prevOpen, setPrevOpen] = useState(isOpen);
  if (prevOpen !== isOpen) {
    setPrevOpen(isOpen);
    if (isOpen) {
      setPsuChoice(null);
      setQuery("");
      setConnectError("");
      setBusyBank(null);
      setChosenBank(null);
      setHistoryKey("year");
    }
  }

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    apiFetch(`/api/bank/aspsps?country=FI&psuType=${psuType}`, { signal: controller.signal })
      .then((response) => readJson<{ aspsps?: Aspsp[] }>(response, "Pankkilistan lataus epäonnistui"))
      .then((data) => {
        if (controller.signal.aborted) return;
        setBanks({ psu: psuType, list: data.aspsps ?? [] });
        setLoadError(null);
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
  }, [isOpen, psuType, attempt]);

  const list = banks?.psu === psuType ? banks.list : null;
  const visible = useMemo(() => {
    if (!list) return null;
    const needle = query.trim().toLocaleLowerCase("fi");
    return needle ? list.filter((bank) => bank.name.toLocaleLowerCase("fi").includes(needle)) : list;
  }, [list, query]);

  async function connect(bank: Aspsp) {
    if (busyBank) return;
    const historyFrom = choices.find((choice) => choice.key === historyKey)?.from ?? null;
    setBusyBank(bank.name);
    setConnectError("");
    try {
      const response = await apiFetch("/api/bank/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aspspName: bank.name,
          aspspCountry: bank.country,
          psuType,
          ...(historyFrom ? { historyFrom } : {}),
          // The server prefixes the auth state with "app1." so the bank's
          // redirect comes back into the app (bank-return.ts).
          ...(IS_MOBILE_BUILD ? { client: "app" as const } : {}),
        }),
      });
      const data = await readJson<{ url: string }>(response, "Yhdistäminen epäonnistui");
      leaveForBank(data.url);
      // Mobile: the bank opens over the app; the sheet is done.
      if (IS_MOBILE_BUILD) {
        window.setTimeout(() => {
          setBusyBank(null);
          onClose();
        }, 800);
      }
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setBusyBank(null);
      setConnectError(errorMessage(error, "Yhdistäminen epäonnistui. Yritä uudelleen."));
    }
  }

  function choosePsu(next: PsuType) {
    if (next === psuType) return;
    void hapticSelection();
    setPsuChoice(next);
  }

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title="Yhdistä pankki"
      subtitle="Kirjaudut pankin omaan palveluun."
      labelledBy={titleId}
      heightClass="h-[85dvh] max-h-[85dvh]"
      dirty={false}
    >
      {chosenBank ? (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pt-1 sheet-safe-bottom">
          <div className="flex items-center gap-3 px-1">
            <BankLogo name={chosenBank.name} logo={chosenBank.logo} />
            <div className="min-w-0">
              <p className="truncate text-body font-semibold text-ink">Mistä lähtien haetaan?</p>
              <p className="text-caption text-ink-2">{chosenBank.name}</p>
            </div>
          </div>
          <div role="radiogroup" aria-label="Mistä lähtien tapahtumat haetaan" className="space-y-2">
            {choices.map((choice) => {
              const selected = choice.key === historyKey;
              return (
                <button
                  key={choice.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    void hapticSelection();
                    setHistoryKey(choice.key);
                  }}
                  className={`active-press flex min-h-14 w-full items-center justify-between gap-3 rounded-card bg-surface px-4 py-2.5 text-left ${
                    selected ? "border-2 border-ink" : "border border-line"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block text-body font-medium text-ink">{choice.label}</span>
                    {choice.hint && <span className="block text-caption text-ink-2">{choice.hint}</span>}
                  </span>
                  <span
                    aria-hidden
                    className={`h-5 w-5 shrink-0 rounded-full border-2 ${selected ? "border-[6px] border-ink" : "border-line"}`}
                  />
                </button>
              );
            })}
          </div>
          <p className="px-1 text-caption text-ink-2">Vanhemmat tapahtumat voi tuoda myöhemmin tiliotetiedostona.</p>
          {connectError && (
            <p className="rounded-card bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">
              {connectError}
            </p>
          )}
          <Button className="w-full" haptic="medium" busy={busyBank !== null} busyLabel="Avataan pankkia…" onClick={() => void connect(chosenBank)}>
            Jatka pankkiin
          </Button>
          <button
            type="button"
            onClick={() => setChosenBank(null)}
            disabled={busyBank !== null}
            className={tintedButtonClass("neutral", "mx-auto")}
          >
            Vaihda pankkia
          </button>
        </div>
      ) : (
      <>
      <div className="shrink-0 space-y-3 px-4 pb-3 pt-1">
        <div role="radiogroup" aria-label="Tilin tyyppi" className="grid grid-cols-2 gap-1 rounded-card bg-line/60 p-1">
          {(["business", "personal"] as const).map((type) => {
            const selected = psuType === type;
            return (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => choosePsu(type)}
                className={`active-press min-h-11 rounded-[10px] text-body font-medium ${
                  selected ? "border border-line bg-surface text-ink" : "border border-transparent text-ink-2"
                }`}
              >
                {type === "business" ? "Yritystili" : "Henkilötili"}
              </button>
            );
          })}
        </div>
        <label className="relative block">
          <span className="sr-only">Hae pankkia</span>
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-ink-2" aria-hidden>
            <Icon icon={Search} size="inline" />
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Hae pankkia"
            enterKeyHint="search"
            autoComplete="off"
            className="box-border block min-h-12 w-full rounded-card border border-line bg-surface pl-9 pr-3 text-input text-ink"
          />
        </label>
        {connectError && (
          <p className="rounded-card bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">
            {connectError}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 sheet-safe-bottom" data-testid="bank-list">
        {loadError != null && !list ? (
          <ConnectionNotice
            error={loadError}
            fallback="Pankkilistan lataus epäonnistui"
            onRetry={() => setAttempt((value) => value + 1)}
            compact
          />
        ) : visible === null ? (
          <SkeletonGroup label="Ladataan pankkeja" className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="flex min-h-14 items-center gap-3 px-4 py-3">
                <Skeleton radius="card" className="h-9 w-9 shrink-0" />
                <Skeleton className="h-3.5 w-2/5" />
              </div>
            ))}
          </SkeletonGroup>
        ) : visible.length === 0 ? (
          query.trim() ? (
            <EmptyState
              kind="filtered"
              icon={Landmark}
              title="Ei osumia"
              body="Hakuasi vastaavaa pankkia ei löytynyt."
              onClear={() => setQuery("")}
              clearLabel="Tyhjennä haku"
            />
          ) : (
            <EmptyState kind="records" icon={Landmark} title="Ei pankkeja vielä" body="Pankkilistaa ei saatu. Yritä myöhemmin uudelleen." />
          )
        ) : (
          <ul className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
            {visible.map((bank) => {
              const busy = busyBank === bank.name;
              return (
                <li key={`${bank.country}-${bank.name}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setConnectError("");
                      setChosenBank(bank);
                    }}
                    disabled={busyBank !== null}
                    aria-label={`Yhdistä ${bank.name}`}
                    className="active-press flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left disabled:opacity-60"
                  >
                    <BankLogo name={bank.name} logo={bank.logo} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-medium text-ink">{bank.name}</span>
                      {bank.beta && <span className="block text-caption text-ink-2">Kokeiluvaiheessa</span>}
                    </span>
                    {busy ? (
                      <span className="flex items-center gap-2 text-caption text-ink-2" role="status">
                        <span
                          className="h-4 w-4 rounded-full border-2 border-accent border-t-transparent animate-spin motion-reduce:animate-none"
                          aria-hidden
                        />
                        Avataan…
                      </span>
                    ) : (
                      <span className="text-ink-2/60" aria-hidden>
                        <Icon icon={ChevronRight} />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      </>
      )}
    </BottomSheet>
  );
}

/** The bank's logo, or its initial on a tile when the logo is missing or fails. */
export function BankLogo({ name, logo, size = "md" }: { name: string; logo: string | null; size?: "md" | "lg" }) {
  const [failed, setFailed] = useState(false);
  const box = size === "lg" ? "h-10 w-10" : "h-9 w-9";
  if (logo && !failed) {
    return (
      // Logos are hosted by Enable Banking, one URL per bank.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logo}
        alt=""
        onError={() => setFailed(true)}
        className={`${box} shrink-0 rounded-[10px] border border-line bg-surface object-contain p-1`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`${box} flex shrink-0 items-center justify-center rounded-[10px] bg-canvas text-body font-semibold text-ink-2`}
    >
      {name.trim().charAt(0).toLocaleUpperCase("fi") || "?"}
    </span>
  );
}
