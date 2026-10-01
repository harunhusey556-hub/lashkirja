/**
 * One reading of `GET /api/bank/connections` for every place that shows the
 * bank connection (OWN-06, BOOKS-01/03/04/05): the Kirjanpito hub row, the
 * top of Pankkitilit and the Tapahtumat card. Pure functions, no React.
 *
 * The server's own `message` (which can name settings) is never shown: the
 * state is decided from `enabled`/`ready` alone and the copy lives here, in
 * plain Finnish (QUALITY-BAR L5, A2).
 */
import { consentReconnectCopy } from "@/lib/bank-consent-copy";

export interface BankAccountSummary {
  id: string;
  iban: string;
  label: string | null;
  currency: string;
  inScope: boolean;
  balance: number | null;
}

export interface BankConnectionSummary {
  id: string;
  aspspName: string;
  aspspCountry: string;
  aspspLogo: string | null;
  psuType: string;
  status: string;
  validUntil: string | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  accounts: BankAccountSummary[];
}

export interface BankConnectionsPayload {
  enabled: boolean;
  ready: boolean;
  connections: BankConnectionSummary[];
}

/**
 * - `unconfigured`: the server has no Enable Banking credentials (switched
 *   off, or switched on with something missing). Connecting cannot work yet.
 * - `none`: ready, nothing connected.
 * - `attention`: at least one connection must be confirmed again.
 * - `connected`: everything connected is usable (or still being confirmed).
 */
export type BankStateKind = "unconfigured" | "none" | "attention" | "connected";

export interface BankState {
  kind: BankStateKind;
  /** Card title. */
  title: string;
  /** One short line under the title (the hub row's secondary). */
  line: string;
}

export const BANK_COPY = {
  unconfiguredTitle: "Pankkiyhteys ei ole vielä käytössä",
  unconfiguredLine: "Ei vielä käytössä",
  unconfiguredBody: "Tapahtumat voi tällä välin tuoda tiedostona tai kirjata käsin.",
  /** The sheet behind "Yhdistä pankki" while the connection is not in use: what works today. */
  setupTitle: "Pankkiyhteys",
  setupLead: "Pankkiyhteys ei ole vielä käytössä. Kun se avataan, tapahtumat haetaan pankista automaattisesti.",
  setupLink: "Mitä voin tehdä nyt?",
  connectTitle: "Yhdistä pankki",
  noneLine: "Ei yhdistetty",
  noneBody: "Tapahtumat haetaan pankista automaattisesti, noin kuuden tunnin välein.",
  attentionLine: "Vaatii uuden vahvistuksen",
} as const;

const STATUS_LINE: Record<string, string> = {
  pending: "odottaa vahvistusta",
  authorizing: "yhdistetään",
};

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "8.05" today, "28.9." another day of this year, "28.9.2025" otherwise. */
export function fetchedWhen(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  if (sameDay(at, now)) return `${at.getHours()}.${String(at.getMinutes()).padStart(2, "0")}`;
  const dayMonth = `${at.getDate()}.${at.getMonth() + 1}.`;
  return at.getFullYear() === now.getFullYear() ? dayMonth : `${dayMonth}${at.getFullYear()}`;
}

/**
 * "•••• 0785 · päivitetty 8.05": the line under an account's name. The IBAN
 * arrives spaced for reading ("FI21 1234 5600 0007 85"), so the tail is taken
 * from the compact form, never from the spaced string.
 */
export function accountSubline(iban: string, lastSuccessAt: string | null, now: Date = new Date()): string {
  const compact = iban.replace(/\s+/g, "");
  const tail = `•••• ${compact.slice(-4)}`;
  const when = lastSuccessAt ? fetchedWhen(lastSuccessAt, now) : "";
  return when ? `${tail} · päivitetty ${when}` : tail;
}

/** "Nordea", "Nordea ja OP", "3 pankkia". */
function bankNames(connections: BankConnectionSummary[]): string {
  const names = [...new Set(connections.map((connection) => connection.aspspName))];
  if (names.length <= 2) return names.join(" ja ");
  return `${names.length} pankkia`;
}

export function needsReconnect(connection: BankConnectionSummary, now: Date = new Date()): boolean {
  return consentReconnectCopy(connection, now) !== null;
}

export function bankState(data: BankConnectionsPayload, now: Date = new Date()): BankState {
  if (!data.enabled || !data.ready) {
    return { kind: "unconfigured", title: BANK_COPY.unconfiguredTitle, line: BANK_COPY.unconfiguredLine };
  }
  const connections = data.connections ?? [];
  if (connections.length === 0) {
    return { kind: "none", title: BANK_COPY.connectTitle, line: BANK_COPY.noneLine };
  }
  const broken = connections.filter((connection) => needsReconnect(connection, now));
  if (broken.length > 0) {
    return {
      kind: "attention",
      title: "Pankkiyhteys",
      line: `${bankNames(broken)}: ${BANK_COPY.attentionLine.toLocaleLowerCase("fi")}`,
    };
  }
  const active = connections.filter((connection) => connection.status === "active");
  if (active.length === 0) {
    const first = connections[0];
    return {
      kind: "connected",
      title: "Pankkiyhteys",
      line: `${first.aspspName}: ${STATUS_LINE[first.status] ?? "odottaa vahvistusta"}`,
    };
  }
  const latest = active
    .map((connection) => connection.lastSuccessAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .pop();
  const fetched = latest ? `, haettu ${fetchedWhen(latest, now)}` : ", ei vielä haettu";
  return { kind: "connected", title: "Pankkiyhteys", line: `${bankNames(active)} yhdistetty${fetched}` };
}
