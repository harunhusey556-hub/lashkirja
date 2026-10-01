import { describe, expect, it } from "vitest";
import { nextReminderWait, reminderWaitMessage, reminderWaitNote } from "./reminder-schedule";

const HOUR = 60 * 60 * 1000;

describe("nextReminderWait", () => {
  it("waits for the end of the term the previous reminder gave, not just 24 hours", () => {
    // Sent 1.10.2026 07:35 Helsinki; it gives the customer until 8.10.2026.
    const sentAt = new Date("2026-10-01T04:35:00.000Z");
    const dueDate = new Date("2026-10-08T00:00:00.000Z");
    const wait = nextReminderWait({ sentAt, dueDate });
    expect(wait.byTerm).toBe(true);
    // The term ends with 8.10.; the next reminder may go from the start of 9.10. Helsinki time (UTC+3).
    expect(wait.at.toISOString()).toBe("2026-10-08T21:00:00.000Z");
  });

  it("uses Helsinki winter time for the start of the next day", () => {
    const sentAt = new Date("2026-12-01T10:00:00.000Z");
    const dueDate = new Date("2026-12-08T00:00:00.000Z");
    expect(nextReminderWait({ sentAt, dueDate }).at.toISOString()).toBe("2026-12-08T22:00:00.000Z");
  });

  it("falls back to 24 hours when the reminder gave no longer term", () => {
    const sentAt = new Date("2026-10-01T04:35:00.000Z");
    const dueDate = new Date("2026-10-01T00:00:00.000Z");
    const wait = nextReminderWait({ sentAt, dueDate });
    expect(wait.byTerm).toBe(false);
    expect(wait.at.getTime()).toBe(sentAt.getTime() + 24 * HOUR);
  });
});

describe("reminderWaitMessage", () => {
  it("names the end of the term and the day the next reminder may go", () => {
    const sentAt = new Date("2026-10-01T04:35:00.000Z");
    const dueDate = new Date("2026-10-08T00:00:00.000Z");
    expect(reminderWaitMessage({ sentAt, dueDate })).toBe(
      "Edellisessä muistutuksessa asiakkaalla on maksuaikaa 8.10.2026 asti. Uuden muistutuksen voi lähettää 9.10.2026 alkaen."
    );
  });

  it("names the real time when the 24 hours decide", () => {
    const sentAt = new Date("2026-09-30T01:35:00.000Z");
    const dueDate = new Date("2026-09-30T00:00:00.000Z");
    expect(reminderWaitMessage({ sentAt, dueDate })).toBe(
      "Muistutus lähetettiin jo 30.9.2026 klo 4.35. Seuraava voidaan lähettää vasta 1.10.2026 klo 4.35."
    );
  });
});

describe("reminderWaitNote", () => {
  const preview = { nextReminderAt: "2026-10-08T21:00:00.000Z", nextReminderNote: "Odota." };

  it("is the note while the wait is ahead and nothing once it is over", () => {
    expect(reminderWaitNote(preview, Date.parse("2026-10-02T10:00:00.000Z"))).toBe("Odota.");
    expect(reminderWaitNote(preview, Date.parse("2026-10-08T21:00:00.000Z"))).toBeNull();
  });

  it("is nothing for a reminder that may go now", () => {
    expect(reminderWaitNote({ nextReminderAt: null, nextReminderNote: null })).toBeNull();
    expect(reminderWaitNote(null)).toBeNull();
  });
});
