export interface AccountSyncRow {
  accountId: string;
  name: string;
  ok: boolean;
  imported: number;
  skipped: number;
  error: string | null;
  /** The bank had more than one pull reads; the account is not caught up. */
  partial?: boolean;
  /** Rows left out because their month is closed. */
  heldBack?: number;
}

/** "1 uusi tapahtuma", "3 uutta tapahtumaa". */
function newRows(count: number): string {
  return count === 1 ? "1 uusi tapahtuma" : `${count} uutta tapahtumaa`;
}

/** One account's line after a sync, never plain "ei uusia" when something waits. */
export function accountOutcomeText(account: AccountSyncRow): string {
  const news = account.imported > 0 ? newRows(account.imported) : "ei uusia tapahtumia";
  const waiting: string[] = [];
  if ((account.heldBack ?? 0) > 0) {
    waiting.push(
      account.heldBack === 1
        ? "1 tapahtuma odottaa lukittua kuukautta"
        : `${account.heldBack} tapahtumaa odottaa lukittua kuukautta`
    );
  }
  if (account.partial) waiting.push("haku jäi kesken");
  return [news, ...waiting].join(", ");
}

/**
 * What a sync can leave out, in one calm sentence each. The server stores the
 * sentence as the connection's `lastError` and the screens show it as a note,
 * not as an alarm: nothing is broken, something is waiting.
 */
export function heldBackNotice(count: number): string {
  return count === 1
    ? "Kuukausi on lukittu, joten 1 tapahtuma tulee vasta, kun avaat kuukauden."
    : `Kuukausi on lukittu, joten ${count} tapahtumaa tulee vasta, kun avaat kuukauden.`;
}

export const PARTIAL_PULL_NOTICE =
  "Kaikkia tapahtumia ei saatu haettua kerralla. Haku jatkuu seuraavalla kerralla.";

export const SHORTENED_NOTICE_START = "Pankki antoi tapahtumat vain viimeisen";

export function shortenedNotice(days: number): string {
  return `${SHORTENED_NOTICE_START} ${days} päivän ajalta, vanhemmat voit tuoda tiliotteena.`;
}

/**
 * The owner asked for history from a closed month: the open months were
 * fetched, the closed ones are not written into finished books. Starts like
 * the held-back notice, so it reads (and is recognised) as the same kind.
 */
export const LOCKED_HISTORY_NOTICE =
  "Kuukausi on lukittu, joten sitä vanhempia tapahtumia ei haettu. Ne haetaan, kun avaat kuukauden.";

const NOTICE_START = [
  "Kuukausi on lukittu, joten",
  "Kaikkia tapahtumia ei saatu haettua kerralla.",
  SHORTENED_NOTICE_START,
];

/** True for a stored `lastError` that is one of the notices above, not a failure. */
export function isSyncNotice(text: string | null | undefined): boolean {
  return Boolean(text) && NOTICE_START.some((start) => text!.startsWith(start));
}

export type SyncTone = "ok" | "note" | "err";

export function syncOutcomeMessage(
  accounts: AccountSyncRow[],
  imported: number,
  notice: string | null = null
): { tone: SyncTone; text: string } {
  const failed = accounts.filter((account) => !account.ok).length;
  const succeeded = accounts.filter((account) => account.ok).length;
  if (failed > 0 && succeeded > 0) {
    return {
      tone: "err",
      text: `Osa tileistä päivittyi. ${succeeded} onnistui, ${failed} epäonnistui.${notice ? ` ${notice}` : ""}`,
    };
  }
  // Something was left out: the answer is never the plain "all is well".
  if (notice) {
    return {
      tone: "note",
      text: imported > 0 ? `Haettiin ${newRows(imported)}. ${notice}` : notice,
    };
  }
  if (imported > 0) {
    return { tone: "ok", text: `Haettiin ${newRows(imported)}.` };
  }
  return { tone: "ok", text: "Ei uusia tapahtumia." };
}

/**
 * What a sync answer may carry about balances (W18's contract: fresh balances
 * and the new `dataVersion` come back with the sync, so the screen needs no
 * second round trip). Every field is optional: an answer without them changes
 * nothing, and the reload that follows brings the truth.
 */
export interface SyncBalanceAnswer {
  accounts?: Array<{ accountId?: string; ok?: boolean; balance?: number | null; balanceCents?: number | null }>;
  balances?: Array<{ accountId?: string; id?: string; balance?: number | null; balanceCents?: number | null }>;
  /** W18: the fresh per-account picture that travels with a sync (the shape of `GET /api/sync/version`). */
  bank?: {
    accounts?: Array<{
      connectedAccountId?: string | null;
      balanceCents?: number | null;
      lastSyncAt?: string | null;
    }>;
  } | null;
  lastSyncAt?: string | null;
  lastSuccessAt?: string | null;
}

function answerBalance(entry: { balance?: number | null; balanceCents?: number | null }): number | null | undefined {
  if (typeof entry.balance === "number" && Number.isFinite(entry.balance)) return entry.balance;
  if (typeof entry.balanceCents === "number" && Number.isFinite(entry.balanceCents)) return entry.balanceCents / 100;
  return undefined;
}

/**
 * The connection list with the balances (and sync time) a sync answer carried
 * applied at once, so the old saldo is never on screen after "Päivitä".
 */
export function applySyncBalances<
  C extends { id: string; lastSyncAt: string | null; lastSuccessAt: string | null; accounts: Array<{ id: string; balance: number | null }> },
>(connections: C[], connectionId: string, answer: SyncBalanceAnswer, nowIso: string): C[] {
  const byAccount = new Map<string, number>();
  for (const entry of answer.balances ?? []) {
    const id = entry.accountId ?? entry.id;
    const balance = answerBalance(entry);
    if (id && balance !== undefined && balance !== null) byAccount.set(id, balance);
  }
  for (const entry of answer.accounts ?? []) {
    const balance = answerBalance(entry);
    if (entry.accountId && balance !== undefined && balance !== null) byAccount.set(entry.accountId, balance);
  }
  for (const entry of answer.bank?.accounts ?? []) {
    const balance = answerBalance(entry);
    if (entry.connectedAccountId && balance !== undefined && balance !== null) byAccount.set(entry.connectedAccountId, balance);
  }
  // A sync where every account failed fetched nothing: it is not a "last success".
  const nothingSucceeded = (answer.accounts ?? []).length > 0 && (answer.accounts ?? []).every((entry) => entry.ok === false);
  return connections.map((connection) =>
    connection.id !== connectionId
      ? connection
      : {
          ...connection,
          lastSyncAt: answer.lastSyncAt ?? nowIso,
          lastSuccessAt: nothingSucceeded ? connection.lastSuccessAt : (answer.lastSuccessAt ?? nowIso),
          accounts: connection.accounts.map((account) =>
            byAccount.has(account.id) ? { ...account, balance: byAccount.get(account.id) ?? account.balance } : account
          ),
        }
  );
}
