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
