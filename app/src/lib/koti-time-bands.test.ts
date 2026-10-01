import { describe, expect, it } from "vitest";
import { kotiTimeBands, type KotiTimeBandInput } from "./koti-time-bands";

const october: KotiTimeBandInput = {
  selectedMonth: "2026-10",
  atCurrent: true,
  today: "2026-10-01",
  previousMonth: { month: "2026-09", open: 28 },
  vat: { periodKey: "2026-08", dueIso: "2026-10-12", settled: false },
};

describe("Koti keeps each period in its own band", () => {
  it("puts a VAT deadline due this month above an open previous month, and the selected month last", () => {
    const bands = kotiTimeBands(october);
    expect(bands.map((band) => band.id)).toEqual(["month:2026-08", "month:2026-09", "selected:2026-10"]);
    expect(bands[0]).toMatchObject({
      caption: "ALV erääntyy",
      captionTone: "default",
      vat: true,
      previousClose: null,
      rows: ["vat"],
    });
    expect(bands[1]).toMatchObject({
      caption: "Syyskuu",
      previousClose: { month: "2026-09", monthName: "Syyskuu", title: "28 asiaa kesken" },
      vat: false,
      rows: ["close"],
    });
    expect(bands[2]).toMatchObject({
      caption: "Tässä kuussa",
      selected: true,
      vat: false,
      previousClose: null,
      selectedClose: false,
    });
  });

  it("puts unfinished last-month work above a deadline that falls later", () => {
    const bands = kotiTimeBands({
      ...october,
      vat: { periodKey: "2026-08", dueIso: "2026-11-12", settled: false },
    });
    expect(bands.map((band) => band.id)).toEqual(["month:2026-09", "month:2026-08", "selected:2026-10"]);
    expect(bands[1].caption).toBe("ALV-ilmoitus");
  });

  it("names an overdue return and keeps it first", () => {
    const bands = kotiTimeBands({
      ...october,
      today: "2026-10-13",
      vat: { periodKey: "2026-08", dueIso: "2026-10-12", settled: false },
    });
    expect(bands[0]).toMatchObject({ id: "month:2026-08", caption: "ALV myöhässä", captionTone: "warning" });
  });

  it("softens the caption once the return is settled, without moving the band", () => {
    const open = kotiTimeBands(october).map((band) => band.id);
    const settled = kotiTimeBands({
      ...october,
      vat: { periodKey: "2026-08", dueIso: "2026-10-12", settled: true },
    });
    expect(settled.map((band) => band.id)).toEqual(open);
    expect(settled[0].caption).toBe("ALV-ilmoitus");
    expect(settled[0].captionTone).toBe("default");
  });

  it("keeps the deadline caption while the figures are still loading", () => {
    const bands = kotiTimeBands({
      ...october,
      vat: { periodKey: "2026-08", dueIso: "2026-10-12", settled: null },
    });
    expect(bands[0].caption).toBe("ALV erääntyy");
  });

  it("uses one band when the VAT period and the open month are the same month", () => {
    const dueLater = kotiTimeBands({
      selectedMonth: "2026-10",
      atCurrent: true,
      today: "2026-10-15",
      previousMonth: { month: "2026-09", open: 4 },
      vat: { periodKey: "2026-09", dueIso: "2026-11-12", settled: false },
    });
    expect(dueLater.map((band) => band.id)).toEqual(["month:2026-09", "selected:2026-10"]);
    expect(dueLater[0].rows).toEqual(["close", "vat"]);
    expect(dueLater[0].caption).toBe("Syyskuu");

    const overdue = kotiTimeBands({
      selectedMonth: "2026-10",
      atCurrent: true,
      today: "2026-10-13",
      previousMonth: { month: "2026-09", open: 4 },
      vat: { periodKey: "2026-09", dueIso: "2026-10-12", settled: false },
    });
    expect(overdue[0].rows).toEqual(["vat", "close"]);
  });

  it("says one thing is kesken, and a finished month is ready to close", () => {
    expect(
      kotiTimeBands({ ...october, previousMonth: { month: "2026-09", open: 1 }, vat: null })[0].previousClose?.title
    ).toBe("1 asia kesken");
    const ready = kotiTimeBands({
      ...october,
      previousMonth: { month: "2026-09", open: 0 },
      vat: { periodKey: "2026-08", dueIso: "2026-11-12", settled: false },
    });
    expect(ready.map((band) => band.id)).toEqual(["month:2026-08", "month:2026-09", "selected:2026-10"]);
    expect(ready[1].previousClose?.title).toBe("Valmis suljettavaksi");
  });

  it("leaves the selected month uncaptioned when nothing from another period is open", () => {
    const bands = kotiTimeBands({ ...october, previousMonth: null, vat: null });
    expect(bands).toEqual([
      {
        id: "selected:2026-10",
        caption: null,
        captionTone: "default",
        vat: false,
        previousClose: null,
        selected: true,
        selectedClose: false,
        rows: [],
      },
    ]);
  });

  it("keeps a past month's own VAT and close on that month", () => {
    const bands = kotiTimeBands({
      selectedMonth: "2026-08",
      atCurrent: false,
      today: "2026-10-01",
      previousMonth: { month: "2026-07", open: 3 },
      vat: { periodKey: "2026-08", dueIso: "2026-10-12", settled: false },
    });
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({
      id: "selected:2026-08",
      caption: null,
      vat: true,
      selectedClose: true,
      previousClose: null,
    });
  });

  it("keeps a quarter's VAT out of the month it ends in", () => {
    const bands = kotiTimeBands({
      selectedMonth: "2026-09",
      atCurrent: false,
      today: "2026-10-01",
      previousMonth: null,
      vat: { periodKey: "2026-Q3", dueIso: "2026-11-12", settled: false },
    });
    expect(bands.map((band) => band.id)).toEqual(["vat:2026-Q3", "selected:2026-09"]);
    expect(bands[0].caption).toBe("ALV-ilmoitus");
    expect(bands[1]).toMatchObject({ caption: "Syyskuu", selectedClose: true, vat: false });
  });

  it("keeps the current month's own return inside this month", () => {
    const bands = kotiTimeBands({
      ...october,
      vat: { periodKey: "2026-10", dueIso: "2026-12-14", settled: false },
    });
    expect(bands.map((band) => band.id)).toEqual(["month:2026-09", "selected:2026-10"]);
    expect(bands[1].vat).toBe(true);
  });
});
