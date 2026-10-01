/**
 * What the payment sheet may tell the user before it sends anything.
 *
 * The server refuses a hand-keyed payment above the open balance, so the sheet
 * says so on the first tap and never offers a second tap that would fail. A
 * payment that carries a bank row records what the bank received and is not
 * capped (the server exempts it too).
 */
import { formatEur } from "./format";

/** Cents of slack, so 125,50 typed against 125,5000001 is not "over". */
const TOLERANCE = 0.004;

export function overOpenMessage(
  amount: number,
  open: number,
  carriesBankRow: boolean
): string | null {
  if (carriesBankRow || amount <= open + TOLERANCE) return null;
  return open > 0
    ? `Summa on suurempi kuin avoin saldo ${formatEur(open)}. Kirjaa enintään avoin summa.`
    : `Lasku on jo maksettu. Avoin saldo on ${formatEur(0)}.`;
}
