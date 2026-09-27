import { describe, expect, it } from "vitest";
import { syncOutcomeMessage, type AccountSyncRow } from "./bank-sync-summary";

function row(partial: Partial<AccountSyncRow> & Pick<AccountSyncRow, "ok">): AccountSyncRow {
  return {
    accountId: partial.accountId ?? "a",
    name: partial.name ?? "Tili",
    ok: partial.ok,
    imported: partial.imported ?? 0,
    skipped: partial.skipped ?? 0,
    error: partial.error ?? null,
  };
}

describe("syncOutcomeMessage", () => {
  it("says which side failed when only some accounts succeed", () => {
    const message = syncOutcomeMessage(
      [row({ ok: true, imported: 3, accountId: "1" }), row({ ok: false, accountId: "2", error: "x" })],
      3
    );
    expect(message.tone).toBe("err");
    expect(message.text).toBe("Osa tileistä päivittyi. 1 onnistui, 1 epäonnistui.");
  });

  it("keeps the all-clear copy when every account succeeds", () => {
    expect(syncOutcomeMessage([row({ ok: true, imported: 2 })], 2).text).toBe(
      "Haettiin 2 uutta tapahtumaa."
    );
    expect(syncOutcomeMessage([row({ ok: true })], 0).text).toBe("Ei uusia tapahtumia.");
  });
});
