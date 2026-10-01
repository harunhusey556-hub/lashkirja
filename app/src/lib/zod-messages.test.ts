import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodErrorBody } from "./zod-messages";
import { nonnegativeMoneySchema } from "./validation";

function issues(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("expected a failure");
  return zodErrorBody(result.error);
}

describe("zodErrorBody", () => {
  it("names the field and the limit in Finnish", () => {
    const body = issues(z.object({ vendor: z.string().max(300), notes: z.string().max(500) }), {
      vendor: "x".repeat(301),
      notes: "y".repeat(501),
    });
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.message).toBe("Tarkista lomakkeen tiedot");
    expect(body.details).toEqual([
      { path: "vendor", field: "vendor", message: "Myyjä saa olla enintään 300 merkkiä" },
      { path: "notes", field: "notes", message: "Selite saa olla enintään 500 merkkiä" },
    ]);
  });

  it("keeps a schema's own Finnish message and says a missing field is missing", () => {
    const body = issues(z.object({ totalAmount: nonnegativeMoneySchema, vendor: z.string() }), {
      totalAmount: 12.345,
    });
    expect(body.details.map((issue) => issue.message)).toEqual([
      "Rahassa saa olla enintään kaksi desimaalia",
      "Myyjä puuttuu",
    ]);
  });

  it("says a too large number is too large, never zod's English", () => {
    const body = issues(z.object({ totalAmount: nonnegativeMoneySchema }), { totalAmount: 99999999999 });
    expect(body.details[0].message).toBe("Summa on liian suuri");
    expect(JSON.stringify(body)).not.toMatch(/Invalid|Too big|expected/);
  });
});
