import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  LEGACY_LIMITED_NOTICE_EN,
  LEGACY_LIMITED_NOTICE_FI,
  displayChatContent,
  hasLegacyLimitedNotice,
  stripLegacyLimitedNotice,
} from "./chat-legacy";
import { limitedModeNotice } from "./chat-policy";

const MIGRATION = path.join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260929120000_strip_legacy_chat_notice",
  "migration.sql"
);
const FORBIDDEN = /Rajattu|Rajoitettu|Limited mode|kielimalli/i;
const VAT_TAIL = "Ripsipalveluiden yleinen ALV-kanta 2026 on **25,5 %**. Katso /kirjanpito/alv.";

describe("stripLegacyLimitedNotice", () => {
  it("drops the old Finnish notice paragraph and keeps the answer", () => {
    const stored = `${LEGACY_LIMITED_NOTICE_FI}\n\n${VAT_TAIL}`;
    expect(hasLegacyLimitedNotice(stored)).toBe(true);
    expect(stripLegacyLimitedNotice(stored)).toBe(VAT_TAIL);
  });

  it("turns a notice-only reply into the current calm notice in the same language", () => {
    expect(stripLegacyLimitedNotice(LEGACY_LIMITED_NOTICE_FI)).toBe(limitedModeNotice(false));
    expect(stripLegacyLimitedNotice(LEGACY_LIMITED_NOTICE_EN)).toBe(limitedModeNotice(true));
  });

  it("catches an older wording that still opens with the label", () => {
    const stored = "Rajattu tila: kielimalli ei ole käytössä.\n\nTallenna kuitti Kuitteihin.";
    expect(stripLegacyLimitedNotice(stored)).toBe("Tallenna kuitti Kuitteihin.");
  });

  it("leaves ordinary replies and user text alone", () => {
    const reply = "Kaikki tiliotteen tapahtumat on jo täsmäytetty kuitteihin.";
    expect(stripLegacyLimitedNotice(reply)).toBe(reply);
    // The label in the middle of a reply is not the notice paragraph.
    expect(stripLegacyLimitedNotice(`Kysyit: ${LEGACY_LIMITED_NOTICE_FI}`)).toBe(`Kysyit: ${LEGACY_LIMITED_NOTICE_FI}`);
    // A user may type anything; only assistant rows are filtered.
    expect(displayChatContent("user", LEGACY_LIMITED_NOTICE_FI)).toBe(LEGACY_LIMITED_NOTICE_FI);
    expect(displayChatContent("assistant", LEGACY_LIMITED_NOTICE_FI)).not.toMatch(FORBIDDEN);
  });
});

describe("migration 20260929120000_strip_legacy_chat_notice", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("uses the exact strings the sanitiser knows", () => {
    const quoted = (text: string) => `'${text.replace(/'/g, "''")}'`;
    expect(sql).toContain(quoted(LEGACY_LIMITED_NOTICE_FI));
    expect(sql).toContain(quoted(LEGACY_LIMITED_NOTICE_EN));
    expect(sql).toContain(quoted(limitedModeNotice(false)));
    expect(sql).toContain(quoted(limitedModeNotice(true)));
  });

  function seeded() {
    const db = new DatabaseSync(":memory:");
    db.exec('CREATE TABLE "ChatMessage" ("id" TEXT PRIMARY KEY, "role" TEXT NOT NULL, "content" TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO "ChatMessage" ("id", "role", "content") VALUES (?, ?, ?)');
    insert.run("fi-vat", "assistant", `${LEGACY_LIMITED_NOTICE_FI}\n\n${VAT_TAIL}`);
    insert.run("fi-only", "assistant", LEGACY_LIMITED_NOTICE_FI);
    insert.run("en-only", "assistant", LEGACY_LIMITED_NOTICE_EN);
    insert.run("en-profile", "assistant", `${LEGACY_LIMITED_NOTICE_EN}\n\nToiminimi, ALV-velvollinen.`);
    insert.run("user-typed", "user", LEGACY_LIMITED_NOTICE_FI);
    insert.run("plain", "assistant", "Hei. Miten voin auttaa?");
    return db;
  }

  function contents(db: DatabaseSync): Record<string, string> {
    const rows = db.prepare('SELECT "id", "content" FROM "ChatMessage"').all() as Array<{ id: string; content: string }>;
    return Object.fromEntries(rows.map((row) => [row.id, row.content]));
  }

  it("rewrites seeded legacy replies, and a second run changes nothing", () => {
    const db = seeded();
    db.exec(sql);
    const once = contents(db);
    expect(once["fi-vat"]).toBe(VAT_TAIL);
    expect(once["fi-only"]).toBe(limitedModeNotice(false));
    expect(once["en-only"]).toBe(limitedModeNotice(true));
    expect(once["en-profile"]).toBe("Toiminimi, ALV-velvollinen.");
    expect(once["user-typed"]).toBe(LEGACY_LIMITED_NOTICE_FI);
    expect(once["plain"]).toBe("Hei. Miten voin auttaa?");
    for (const id of ["fi-vat", "fi-only", "en-only", "en-profile"]) expect(once[id]).not.toMatch(FORBIDDEN);

    db.exec(sql);
    expect(contents(db)).toEqual(once);
  });

  it("agrees with the display-time sanitiser row for row", () => {
    const db = seeded();
    const before = db.prepare('SELECT "id", "role", "content" FROM "ChatMessage"').all() as Array<{
      id: string;
      role: string;
      content: string;
    }>;
    db.exec(sql);
    const after = contents(db);
    for (const row of before) expect(after[row.id]).toBe(displayChatContent(row.role, row.content));
  });
});
