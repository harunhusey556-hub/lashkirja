import { z } from "zod";
import { isCalendarDay } from "./connect";

/** POST /api/bank/connections: which bank, whose, and from when the first sync reads. */
export const startSchema = z.object({
  aspspName: z.string().trim().min(1).max(120),
  aspspCountry: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/)
    .default("FI"),
  psuType: z.enum(["personal", "business"]),
  client: z.enum(["web", "app"]).optional().default("web"),
  /** First sync starts here ("Mistä lähtien haetaan?"); omitted = all the bank allows. */
  historyFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    // A day that exists (2026-02-31 does not) and is not in the future.
    .refine((value) => isCalendarDay(value) && value <= new Date().toISOString().slice(0, 10), {
      message: "Virheellinen päivä",
    })
    .optional(),
});
