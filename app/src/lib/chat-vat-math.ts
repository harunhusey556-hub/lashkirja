/**
 * VAT arithmetic on figures the user typed ("45 € sis. alv 25,5 %"). The server
 * does the sums, so the model can quote them and the honesty guard can accept
 * them: every figure here comes from the user's own numbers, not the books.
 */

/** Finnish VAT rates in force, used when the message names VAT but no rate. */
const FINNISH_RATES = [25.5, 14, 13.5, 10];

export interface VatFigure {
  amount: string;
  rate: number;
  /** The amount read as VAT included: net + VAT = amount. */
  included: { net: string; vat: string };
  /** The amount read as VAT excluded: amount + VAT = gross. */
  excluded: { vat: string; gross: string };
}

const toCents = (euros: number) => Math.round(euros * 100 + Number.EPSILON * 100);
const fmt = (cents: number) => (cents / 100).toFixed(2);

function parseNumber(raw: string): number | null {
  const value = Number(raw.replace(/[\s ]/g, "").replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Euro amounts in a message: "45 €", "49,80 €", "€12.50", "1 200 euroa". */
export function userEuroAmounts(text: string): number[] {
  const number = String.raw`(\d{1,3}(?:[\s ]\d{3})+|\d+)(?:[.,](\d{1,2}))?`;
  const found: number[] = [];
  const patterns = [new RegExp(`${number}\\s*(?:€|e\\b|eur\\b|euroa?\\b|euro\\b)`, "gi"), new RegExp(`€\\s*${number}`, "g")];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = parseNumber(match[2] ? `${match[1]}.${match[2]}` : match[1]);
      if (value !== null && value < 10_000_000 && !found.includes(value)) found.push(value);
    }
  }
  return found;
}

/** VAT rates in a message ("25,5 %", "14%"); Finnish rates when VAT is named without one. */
export function userVatRates(text: string): number[] {
  const rates: number[] = [];
  for (const match of text.matchAll(/(\d{1,2}(?:[.,]\d)?)\s*%/g)) {
    const rate = parseNumber(match[1]);
    if (rate !== null && rate < 100 && !rates.includes(rate)) rates.push(rate);
  }
  if (rates.length > 0) return rates;
  return /\b(?:alv|vat|kdv|arvonlisävero)/i.test(text) ? FINNISH_RATES : [];
}

export function userVatFigures(text: string): VatFigure[] {
  const rates = userVatRates(text);
  if (rates.length === 0) return [];
  const amounts = userEuroAmounts(text).slice(0, 6);
  return amounts.flatMap((amount) =>
    rates.map((rate) => {
      const cents = toCents(amount);
      const net = Math.round(cents / (1 + rate / 100));
      const vatOnTop = Math.round((cents * rate) / 100);
      return {
        amount: fmt(cents),
        rate,
        included: { net: fmt(net), vat: fmt(cents - net) },
        excluded: { vat: fmt(vatOnTop), gross: fmt(cents + vatOnTop) },
      };
    })
  );
}

/** Every figure the guard may accept for these calculations. */
export function vatFigureAmounts(figures: readonly VatFigure[]): string[] {
  return [...new Set(figures.flatMap((f) => [f.amount, f.included.net, f.included.vat, f.excluded.vat, f.excluded.gross]))];
}

/** One prompt line per figure, so the model quotes the server's sums. */
export function describeVatFigures(figures: readonly VatFigure[]): string {
  return figures
    .map(
      (f) =>
        `${f.amount} EUR at ${f.rate} %: if VAT included -> net ${f.included.net}, VAT ${f.included.vat}; if VAT excluded -> VAT ${f.excluded.vat}, gross ${f.excluded.gross}`
    )
    .join("\n");
}
