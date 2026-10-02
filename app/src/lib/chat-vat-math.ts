/**
 * VAT arithmetic on figures the user typed ("45 € sis. alv 25,5 %"). The server
 * does the sums, so the model can quote them and the honesty guard can accept
 * them: every figure here comes from the user's own numbers, not the books.
 */

/** Finnish VAT rates in force, used when the message names VAT but no rate. */
const FINNISH_RATES = [25.5, 14, 13.5, 10];

const MAX_AMOUNTS = 6;

export interface VatFigure {
  amount: string;
  rate: number;
  /** The amount read as VAT included: net + VAT = amount. */
  included: { net: string; vat: string };
  /** The amount read as VAT excluded: amount + VAT = gross. */
  excluded: { vat: string; gross: string };
  /** "3 × 89,00 €" or "45,00 € + 49,80 €" when the amount was built from the message. */
  label?: string;
}

const toCents = (euros: number) => Math.round(euros * 100 + Number.EPSILON * 100);
const fmt = (cents: number) => (cents / 100).toFixed(2);
const fi = (cents: number) => `${fmt(cents).replace(".", ",")} €`;

function parseNumber(raw: string): number | null {
  const value = Number(raw.replace(/[\s ]/g, "").replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
}

const NUMBER = String.raw`(\d{1,3}(?:[\s ]\d{3})+|\d+)(?:[.,](\d{1,2}))?`;
// "45 €", "45e", "45 eur", "45 euroa", "200 eurosta", "€45".
const AFTER = String.raw`\s*(?:€|e\b|eur(?:o\p{L}*)?\b)`;

function numberAt(match: RegExpMatchArray, whole: number, cents: number): number | null {
  return parseNumber(match[cents] ? `${match[whole]}.${match[cents]}` : match[whole]);
}

/** Euro amounts in a message, in the order written. */
export function userEuroAmounts(text: string): number[] {
  const found: Array<{ at: number; value: number }> = [];
  const patterns = [new RegExp(`${NUMBER}${AFTER}`, "giu"), new RegExp(`€\\s*${NUMBER}`, "gu")];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = numberAt(match, 1, 2);
      if (value !== null && value < 10_000_000) found.push({ at: match.index ?? 0, value });
    }
  }
  const values: number[] = [];
  for (const { value } of found.sort((a, b) => a.at - b.at)) if (!values.includes(value)) values.push(value);
  return values;
}

const COUNT_WORDS: Record<string, number> = {
  kaksi: 2, kolme: 3, neljä: 4, viisi: 5, kuusi: 6, seitsemän: 7, kahdeksan: 8, yhdeksän: 9, kymmenen: 10,
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** "3 kertaa 89 €", "3 x 89 €", "3 kpl à 89 €", "kolme kertaa 89 €": [count, unit price]. */
export function userQuantities(text: string): Array<{ count: number; unit: number }> {
  const count = String.raw`(\d{1,4}|${Object.keys(COUNT_WORDS).join("|")})`;
  const pattern = new RegExp(`${count}\\s*(?:x|×|\\*|kertaa|krt|kpl|times)\\s*(?:à|a|@)?\\s*${NUMBER}${AFTER}`, "giu");
  const out: Array<{ count: number; unit: number }> = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[1].toLocaleLowerCase("fi");
    const n = COUNT_WORDS[raw] ?? Number(raw);
    const unit = numberAt(match, 2, 3);
    if (n > 1 && n <= 1000 && unit !== null) out.push({ count: n, unit });
  }
  return out;
}

/** VAT rates in a message ("25,5 %", "14%"); Finnish rates when VAT is named without one. */
export function userVatRates(text: string): number[] {
  const rates: number[] = [];
  for (const match of text.matchAll(/(\d{1,2}(?:[.,]\d)?)\s*%/g)) {
    const rate = Number(match[1].replace(",", "."));
    if (Number.isFinite(rate) && rate >= 0 && rate < 100 && !rates.includes(rate)) rates.push(rate);
  }
  if (rates.length > 0) return rates;
  return /\b(?:alv|vat|kdv|arvonlisävero)/i.test(text) ? FINNISH_RATES : [];
}

function figure(cents: number, rate: number, label?: string): VatFigure {
  const net = Math.round(cents / (1 + rate / 100));
  const vatOnTop = Math.round((cents * rate) / 100);
  return {
    amount: fmt(cents),
    rate,
    included: { net: fmt(net), vat: fmt(cents - net) },
    excluded: { vat: fmt(vatOnTop), gross: fmt(cents + vatOnTop) },
    ...(label ? { label } : {}),
  };
}

export function userVatFigures(text: string): VatFigure[] {
  const rates = userVatRates(text);
  if (rates.length === 0) return [];
  const amounts = userEuroAmounts(text).slice(0, MAX_AMOUNTS).map(toCents);
  const quantities = userQuantities(text).slice(0, MAX_AMOUNTS);
  const figures: VatFigure[] = [];
  for (const rate of rates) {
    for (const cents of amounts) figures.push(figure(cents, rate));
    // "3 kertaa 89 €": the total of the three.
    for (const { count, unit } of quantities) {
      const unitCents = toCents(unit);
      figures.push(figure(unitCents * count, rate, `${count} × ${fi(unitCents)}`));
    }
    // Several amounts: their total, the usual follow-up ("paljonko yhteensä").
    if (amounts.length > 1) {
      figures.push(figure(amounts.reduce((sum, c) => sum + c, 0), rate, amounts.map(fi).join(" + ")));
    }
  }
  return figures;
}

/** Sums of the per-amount VAT and net figures, for "ALV yhteensä" answers built row by row. */
function rowTotals(figures: readonly VatFigure[]): string[] {
  const byRate = new Map<number, VatFigure[]>();
  for (const f of figures) if (!f.label) byRate.set(f.rate, [...(byRate.get(f.rate) ?? []), f]);
  const out: string[] = [];
  for (const group of byRate.values()) {
    if (group.length < 2) continue;
    const sum = (pick: (f: VatFigure) => string) => fmt(group.reduce((total, f) => total + toCents(Number(pick(f))), 0));
    out.push(sum((f) => f.included.net), sum((f) => f.included.vat), sum((f) => f.excluded.vat), sum((f) => f.excluded.gross));
  }
  return out;
}

/**
 * Every figure the guard may accept for these calculations, with a cent
 * either way: rounding each row or the total can differ by one cent
 * (3 × 18,08 € = 54,24 €, while the VAT of 267,00 € is 54,25 €).
 */
export function vatFigureAmounts(figures: readonly VatFigure[]): string[] {
  const exact = [
    ...figures.flatMap((f) => [f.amount, f.included.net, f.included.vat, f.excluded.vat, f.excluded.gross]),
    ...rowTotals(figures),
  ];
  const all = new Set<string>();
  for (const value of exact) {
    const cents = toCents(Number(value));
    for (const near of [cents - 1, cents, cents + 1]) if (near >= 0) all.add(fmt(near));
  }
  return [...all];
}

/** One prompt line per figure, in the words the reply should use. */
export function describeVatFigures(figures: readonly VatFigure[]): string {
  const lines = figures.map((f) => {
    const cents = toCents(Number(f.amount));
    const head = f.label ? `${f.label} = ${fi(cents)}` : fi(cents);
    return (
      `${head}, ALV ${String(f.rate).replace(".", ",")} %: ` +
      `jos hinta sisältää ALV:n → veroton ${fi(toCents(Number(f.included.net)))}, ALV ${fi(toCents(Number(f.included.vat)))}; ` +
      `jos hinta on veroton → ALV ${fi(toCents(Number(f.excluded.vat)))}, verollinen ${fi(toCents(Number(f.excluded.gross)))}`
    );
  });
  const totals = rowTotals(figures);
  if (totals.length >= 4) {
    lines.push(
      `Rivien summat: veroton ${fi(toCents(Number(totals[0])))}, ALV ${fi(toCents(Number(totals[1])))} (hinnat sis. ALV); ` +
        `ALV ${fi(toCents(Number(totals[2])))}, verollinen ${fi(toCents(Number(totals[3])))} (hinnat verottomia)`
    );
  }
  return lines.join("\n");
}

/** A plain answer from the figures alone, for when no model is available. */
export function vatArithmeticReply(figures: readonly VatFigure[], english: boolean): string {
  const shown = figures.slice(0, 4).map((f) => {
    const money = (value: string) => (english ? `${value} €` : fi(toCents(Number(value))));
    const amount = f.label ? `${f.label} = ${money(f.amount)}` : money(f.amount);
    const rate = english ? `${f.rate} %` : `${String(f.rate).replace(".", ",")} %`;
    return english
      ? `- ${amount}, VAT ${rate}: incl. VAT → net ${money(f.included.net)}, VAT ${money(f.included.vat)}; excl. VAT → VAT ${money(f.excluded.vat)}, total ${money(f.excluded.gross)}`
      : `- ${amount}, ALV ${rate}: sis. ALV → veroton ${money(f.included.net)}, ALV ${money(f.included.vat)}; veroton hinta → ALV ${money(f.excluded.vat)}, verollinen ${money(f.excluded.gross)}`;
  });
  return [english ? "Calculated from your figures:" : "Laskettu antamistasi luvuista:", ...shown].join("\n");
}
