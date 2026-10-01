import { describe, expect, it } from "vitest";
import { groupFailedJobs } from "./work-queue-group";

const reason = "Kuitista ei saatu luettua tekstiä. Kokeile terävämpää kuvaa tai tekstipohjaista PDF:ää.";
const job = (id: string, day: number, error: string | null = reason, title = "Kuitin analysointi: e2e-preview.jpg") => ({
  id,
  kind: "document_analysis",
  title,
  error,
  createdAt: new Date(Date.UTC(2026, 8, day, 9)),
});

describe("F29: identical failed reads are one row with one retry", () => {
  it("groups the same day and reason into one row with a count and every job id, newest first", () => {
    const groups = groupFailedJobs([job("a", 28), job("b", 28), job("c", 28), job("d", 27)]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ id: "a", count: 3, jobIds: ["a", "b", "c"], title: "Kuitti 28.9. (3 kuvaa)" });
    expect(groups[1]).toMatchObject({ id: "d", count: 1, jobIds: ["d"], title: "Kuitti 27.9." });
  });

  it("keeps different reasons apart and never shows a file name", () => {
    const groups = groupFailedJobs([job("a", 28), job("b", 28, "PDF:n tekstin luku epäonnistui")]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.title).join(" ")).not.toMatch(/\.jpg|analysointi/i);
  });

  it("a job with no stored reason gets the plain advice", () => {
    expect(groupFailedJobs([job("a", 28, null)])[0].detail).toMatch(/terävämpää kuvaa/);
  });
});
