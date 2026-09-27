export interface AccountSyncRow {
  accountId: string;
  name: string;
  ok: boolean;
  imported: number;
  skipped: number;
  error: string | null;
}

export function syncOutcomeMessage(
  accounts: AccountSyncRow[],
  imported: number
): { tone: "ok" | "err"; text: string } {
  const failed = accounts.filter((account) => !account.ok).length;
  const succeeded = accounts.filter((account) => account.ok).length;
  if (failed > 0 && succeeded > 0) {
    return {
      tone: "err",
      text: `Osa tileistä päivittyi. ${succeeded} onnistui, ${failed} epäonnistui.`,
    };
  }
  if (imported > 0) {
    return { tone: "ok", text: `Haettiin ${imported} uutta tapahtumaa.` };
  }
  return { tone: "ok", text: "Ei uusia tapahtumia." };
}
