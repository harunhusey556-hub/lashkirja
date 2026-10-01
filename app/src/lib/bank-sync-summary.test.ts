import { describe, expect, it } from "vitest";
import {
  PARTIAL_PULL_NOTICE,
  accountOutcomeText,
  heldBackNotice,
  isSyncNotice,
  shortenedNotice,
  syncOutcomeMessage,
  type AccountSyncRow,
} from "./bank-sync-summary";

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

describe("V31: a sync that left something out never reads as plain success", () => {
  it("says what is waiting instead of 'Ei uusia tapahtumia.'", () => {
    const message = syncOutcomeMessage([row({ ok: true })], 0, heldBackNotice(2));
    expect(message.tone).toBe("note");
    expect(message.text).toBe("Kuukausi on lukittu, joten 2 tapahtumaa tulee vasta, kun avaat kuukauden.");
    expect(message.text).not.toMatch(/Ei uusia/);
  });

  it("keeps the news and adds the notice", () => {
    const message = syncOutcomeMessage([row({ ok: true, imported: 3 })], 3, PARTIAL_PULL_NOTICE);
    expect(message.tone).toBe("note");
    expect(message.text).toBe(`Haettiin 3 uutta tapahtumaa. ${PARTIAL_PULL_NOTICE}`);
  });

  it("a partly failed sync stays an error and still carries the notice", () => {
    const message = syncOutcomeMessage(
      [row({ ok: true, accountId: "1" }), row({ ok: false, accountId: "2", error: "x" })],
      0,
      heldBackNotice(1)
    );
    expect(message.tone).toBe("err");
    expect(message.text).toContain("1 tapahtuma tulee vasta");
  });

  it("recognises the stored notices and not a failure", () => {
    expect(isSyncNotice(heldBackNotice(1))).toBe(true);
    expect(isSyncNotice(PARTIAL_PULL_NOTICE)).toBe(true);
    expect(isSyncNotice(shortenedNotice(90))).toBe(true);
    expect(isSyncNotice("Pankin vastausta ei voitu lukea. Yritä uudelleen.")).toBe(false);
    expect(isSyncNotice(null)).toBe(false);
  });

  it("the shortened-history sentence names the days and the way forward", () => {
    expect(shortenedNotice(90)).toBe(
      "Pankki antoi tapahtumat vain viimeisen 90 päivän ajalta, vanhemmat voit tuoda tiliotteena."
    );
  });
});

describe("accountOutcomeText", () => {
  it("names what waits instead of 'ei uusia tapahtumia' alone", () => {
    expect(accountOutcomeText(row({ ok: true, imported: 2 }))).toBe("2 uutta tapahtumaa");
    expect(accountOutcomeText(row({ ok: true }))).toBe("ei uusia tapahtumia");
    expect(accountOutcomeText({ ...row({ ok: true }), heldBack: 2 })).toBe(
      "ei uusia tapahtumia, 2 tapahtumaa odottaa lukittua kuukautta"
    );
    expect(accountOutcomeText({ ...row({ ok: true, imported: 1 }), heldBack: 1, partial: true })).toBe(
      "1 uusi tapahtuma, 1 tapahtuma odottaa lukittua kuukautta, haku jäi kesken"
    );
  });
});
