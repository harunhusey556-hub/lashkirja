/**
 * Finnish VAT inference rules (2026) — seed logic from deep-research VAT guide.
 * Default: 25.5% unless category/treatment positively establishes otherwise.
 */

import { amountsOnLine } from "./finnish-numbers";

export type VatTreatment =
  | "STANDARD_25_5"
  | "REDUCED_13_5"
  | "REDUCED_10"
  | "ZERO_WITH_DEDUCTION"
  | "EXEMPT_NO_DEDUCTION"
  | "UNKNOWN_REVIEW";

export interface VatLineGuess {
  rate: number;
  amount: number;
}

export interface VatGuessResult {
  vatDetails: VatLineGuess[];
  treatment: VatTreatment;
  confidence: number;
  note: string | null;
  /** Non-deductible reminder/late fees separated from the taxable base. */
  nonDeductibleFee: number | null;
}

const REMINDER_FEE_LINE =
  /muistutusmaksu|viivästysmaksu|viivästyskorko|perintäkulu|perintämaksu|myöhästymismaksu|reminder fee|late fee|due fee|korko\b.*viiv/i;

const PAYROLL_PROVIDER =
  /accountor|palkka\.fi|palkkahallinto|palkkatoimisto|palkkafirma|palkkakeskus/i;

/** Category → default VAT treatment when receipt omits ALV breakdown. */
const CATEGORY_TREATMENT: Record<string, VatTreatment> = {
  tarvikkeet: "STANDARD_25_5",
  vuokra: "STANDARD_25_5",
  sähkö: "STANDARD_25_5",
  vesi: "STANDARD_25_5",
  "puhelin/netti": "STANDARD_25_5",
  ohjelmistot: "STANDARD_25_5",
  polttoaine: "STANDARD_25_5",
  rahti: "STANDARD_25_5",
  matkakulut: "STANDARD_25_5",
  markkinointi: "STANDARD_25_5",
  koulutus: "STANDARD_25_5",
  vakuutus: "EXEMPT_NO_DEDUCTION",
  työeläke: "EXEMPT_NO_DEDUCTION",
  työllisyysrahasto: "EXEMPT_NO_DEDUCTION",
  pankki: "EXEMPT_NO_DEDUCTION",
  verot: "EXEMPT_NO_DEDUCTION",
  kuntavero: "EXEMPT_NO_DEDUCTION",
  rahoitus: "EXEMPT_NO_DEDUCTION",
  palkka: "EXEMPT_NO_DEDUCTION",
  muut: "STANDARD_25_5",
};

const TREATMENT_RATE: Partial<Record<VatTreatment, number>> = {
  STANDARD_25_5: 25.5,
  REDUCED_13_5: 13.5,
  REDUCED_10: 10,
  ZERO_WITH_DEDUCTION: 0,
};



function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Extract reminder / late-payment fees that are not input-VAT deductible. */
export function extractReminderFees(text: string): number {
  let total = 0;
  for (const line of text.split("\n")) {
    if (!REMINDER_FEE_LINE.test(line)) continue;
    const amounts = amountsOnLine(line);
    if (amounts.length > 0) {
      total += amounts[amounts.length - 1];
    }
  }
  return round2(total);
}

function vatFromGross(gross: number, rate: number): VatLineGuess {
  if (rate === 0) return { rate: 0, amount: 0 };
  const amount = round2((gross * rate) / (100 + rate));
  return { rate, amount };
}

function treatmentForCategory(category: string | null): VatTreatment {
  if (!category) return "STANDARD_25_5";
  return CATEGORY_TREATMENT[category] ?? "STANDARD_25_5";
}

function vendorTreatmentOverride(
  vendor: string | null,
  text: string
): VatTreatment | null {
  const hay = `${vendor ?? ""} ${text}`.toLowerCase();
  if (/\b(yel|työeläke|tyoelake|varma|elo)\b/.test(hay)) {
    return "EXEMPT_NO_DEDUCTION";
  }
  if (/\b(vakuutus|fennia|pohjola|if vakuutus)\b/.test(hay)) {
    return "EXEMPT_NO_DEDUCTION";
  }
  if (/\b(verohallinto|ennakkomaksu|kunnallisvero)\b/.test(hay)) {
    return "EXEMPT_NO_DEDUCTION";
  }
  if (/\b(holvi|pankki|palvelumaksu|tilimaksu)\b/.test(hay) && /palvelu|maksu/i.test(hay)) {
    return "EXEMPT_NO_DEDUCTION";
  }
  return null;
}

/**
 * Guess VAT breakdown when the document omits explicit ALV lines.
 * Does not override an existing non-empty breakdown.
 */
export function guessVatForReceipt(input: {
  category: string | null;
  vendor: string | null;
  text: string;
  totalAmount: number | null;
  existingVatDetails: { rate: number; amount: number }[];
}): VatGuessResult | null {
  if (input.existingVatDetails.length > 0) return null;
  if (input.totalAmount == null || input.totalAmount <= 0) return null;

  const reminderFee = extractReminderFees(input.text);
  const taxableGross = round2(Math.max(0, input.totalAmount - reminderFee));

  const treatment =
    vendorTreatmentOverride(input.vendor, input.text) ??
    treatmentForCategory(input.category);

  if (treatment === "EXEMPT_NO_DEDUCTION") {
    return {
      vatDetails: [{ rate: 0, amount: 0 }],
      treatment,
      confidence: 0.85,
      note: reminderFee
        ? `ALV-vapaa. Muistutusmaksu ${reminderFee.toFixed(2).replace(".", ",")} € ei ole vähennyskelpoinen.`
        : "ALV-vapaa — ei vähennyskelpoista ALV:ta.",
      nonDeductibleFee: reminderFee || null,
    };
  }

  if (treatment === "UNKNOWN_REVIEW") {
    return {
      vatDetails: [],
      treatment,
      confidence: 0.3,
      note: "ALV-kanta epävarma — tarkista manuaalisesti.",
      nonDeductibleFee: reminderFee || null,
    };
  }

  const rate = TREATMENT_RATE[treatment] ?? 25.5;
  const vatLine = vatFromGross(taxableGross, rate);

  let note: string | null = null;
  if (reminderFee > 0) {
    note = `ALV laskettu vain pääsummasta. Muistutusmaksu ${reminderFee.toFixed(2).replace(".", ",")} € ei ole vähennyskelpoinen.`;
  } else if (treatment !== "STANDARD_25_5") {
    note = `ALV arvioitu kategoriasta (${rate} %).`;
  } else {
    note = "ALV arvioitu oletuskannalla 25,5 % — tarkista tarvittaessa.";
  }

  return {
    vatDetails: [vatLine],
    treatment,
    confidence: reminderFee > 0 ? 0.75 : 0.65,
    note,
    nonDeductibleFee: reminderFee || null,
  };
}

export function categoriesVatHintsForAiPrompt(): string {
  return Object.entries(CATEGORY_TREATMENT)
    .map(([cat, treatment]) => {
      const rate = TREATMENT_RATE[treatment];
      if (treatment === "EXEMPT_NO_DEDUCTION") {
        return `- ${cat}: ALV-vapaa, vatDetails [{rate:0, amount:0}]`;
      }
      return `- ${cat}: oletus ${rate ?? 25.5}%`;
    })
    .join("\n");
}

export { PAYROLL_PROVIDER, REMINDER_FEE_LINE };
