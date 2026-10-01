import { isCentAmount, MAX_MONEY_EUR } from "./money";

/**
 * Why an amount a person typed cannot be saved, in plain Finnish, or null.
 * The same two rules the server's money schema enforces, so a form can refuse
 * the value at its field instead of getting a bare failure back (F64).
 */
export function moneyEntryProblem(value: number): string | null {
  if (Math.abs(value) > MAX_MONEY_EUR) return "Summa on liian suuri.";
  if (!isCentAmount(value)) return "Summassa saa olla enintään kaksi desimaalia.";
  return null;
}
