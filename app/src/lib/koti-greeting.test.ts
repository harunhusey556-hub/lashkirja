import { describe, expect, it } from "vitest";
import { countThings, helsinkiClock, kotiGreeting, timeOfDayGreeting } from "./koti-greeting";

const base = { firstName: "Liisa", blockingCount: 0, hasActivity: true, setupEmpty: false, previousMonth: null };
// Helsinki is UTC+3 in summer (EEST), UTC+2 in winter.
const at = (iso: string) => new Date(iso);

describe("time of day greeting", () => {
  it("uses the Helsinki hour, not the device hour", () => {
    expect(kotiGreeting({ ...base, now: at("2026-10-14T05:30:00Z") })).toBe("Hyvää huomenta, Liisa"); // 08:30
    expect(kotiGreeting({ ...base, now: at("2026-10-14T10:00:00Z") })).toBe("Hyvää päivää, Liisa"); // 13:00
    expect(kotiGreeting({ ...base, now: at("2026-10-14T16:00:00Z") })).toBe("Hyvää iltaa, Liisa"); // 19:00
    expect(kotiGreeting({ ...base, now: at("2026-10-14T21:30:00Z") })).toBe("Hyvää yötä, Liisa"); // 00:30
  });

  it("has exact hour boundaries", () => {
    expect(timeOfDayGreeting(4, "A")).toBe("Hyvää yötä, A");
    expect(timeOfDayGreeting(5, "A")).toBe("Hyvää huomenta, A");
    expect(timeOfDayGreeting(9, "A")).toBe("Hyvää huomenta, A");
    expect(timeOfDayGreeting(10, "A")).toBe("Hyvää päivää, A");
    expect(timeOfDayGreeting(16, "A")).toBe("Hyvää päivää, A");
    expect(timeOfDayGreeting(17, "A")).toBe("Hyvää iltaa, A");
    expect(timeOfDayGreeting(22, "A")).toBe("Hyvää iltaa, A");
    expect(timeOfDayGreeting(23, "A")).toBe("Hyvää yötä, A");
  });

  it("says nothing without a name", () => {
    expect(kotiGreeting({ ...base, firstName: " ", now: at("2026-10-14T10:00:00Z") })).toBeNull();
  });

  it("reads the Helsinki clock across the winter and summer offset", () => {
    expect(helsinkiClock(at("2026-12-31T22:30:00Z"))).toEqual({ hour: 0, day: 1, daysInMonth: 31 });
    expect(helsinkiClock(at("2026-10-31T21:30:00Z"))).toEqual({ hour: 23, day: 31, daysInMonth: 31 }); // winter time from 25.10.
    expect(helsinkiClock(at("2026-02-28T12:00:00Z")).daysInMonth).toBe(28);
  });
});

describe("the month sentence is said only when it is true", () => {
  const lastDay = at("2026-10-31T10:00:00Z");
  const firstDay = at("2026-11-01T10:00:00Z");

  it("last day with things open", () => {
    expect(kotiGreeting({ ...base, now: lastDay, blockingCount: 2 })).toBe("Kuukauden viimeinen päivä. Vielä kaksi asiaa.");
    expect(kotiGreeting({ ...base, now: lastDay, blockingCount: 1 })).toBe("Kuukauden viimeinen päivä. Vielä yksi asia.");
    expect(kotiGreeting({ ...base, now: lastDay, blockingCount: 14 })).toBe("Kuukauden viimeinen päivä. Vielä 14 asiaa.");
  });

  it("last day with nothing open says it only for a month that has something in it", () => {
    expect(kotiGreeting({ ...base, now: lastDay })).toBe("Kuukauden viimeinen päivä. Kirjanpito on ajan tasalla.");
    expect(kotiGreeting({ ...base, now: lastDay, hasActivity: false })).toBe("Hyvää päivää, Liisa");
  });

  it("a brand-new account is never told about its month", () => {
    expect(kotiGreeting({ ...base, now: lastDay, setupEmpty: true, hasActivity: false })).toBe("Hyvää päivää, Liisa");
  });

  it("first day speaks about the month before only when it is not closed", () => {
    expect(kotiGreeting({ ...base, now: firstDay, previousMonth: { month: "2026-10", open: 3 } })).toBe("Lokakuussa on vielä kolme asiaa.");
    expect(kotiGreeting({ ...base, now: firstDay, previousMonth: { month: "2026-10", open: 0 } })).toBe("Lokakuu on valmis suljettavaksi.");
    expect(kotiGreeting({ ...base, now: firstDay, previousMonth: null })).toBe("Hyvää päivää, Liisa");
  });

  it("an ordinary day never gets a month sentence", () => {
    expect(kotiGreeting({ ...base, now: at("2026-10-15T10:00:00Z"), blockingCount: 5, previousMonth: { month: "2026-10", open: 2 } })).toBe("Hyvää päivää, Liisa");
  });

  it("counts in words up to ten", () => {
    expect(countThings(10)).toBe("kymmenen asiaa");
    expect(countThings(11)).toBe("11 asiaa");
  });
});
