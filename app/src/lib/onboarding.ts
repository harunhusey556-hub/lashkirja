import { z } from "zod";

/** A chip answers one onboarding question: a flag, a choice or a tag. */
export type ChipValue = string | boolean;

export const SALES_TYPES = ["ripsipalvelut", "kulmapalvelut", "koulutus", "tuotemyynti"] as const;
export const EXPENSE_CATEGORIES = ["tarvikkeet", "vuokra", "markkinointi", "koulutuskulut"] as const;
export const VAT_PERIODS = ["month", "quarter", "year"] as const;

/** Company types shared by onboarding, settings and the profile PATCH schema. */
export const ENTITY_TYPES = ["toiminimi", "kevytyrittaja", "oy"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_TYPE_OPTIONS: { value: EntityType; label: string }[] = [
  { value: "toiminimi", label: "Toiminimi" },
  { value: "kevytyrittaja", label: "Kevytyrittäjä" },
  { value: "oy", label: "Osakeyhtiö (Oy)" },
];

export interface BusinessProfile {
  entityType: EntityType;
  vatRegistered: boolean;
  vatPeriod: (typeof VAT_PERIODS)[number];
  salesTypes: string[];
  expenseCategories: string[];
  summaryNote?: string;
}

export const businessProfileSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  vatRegistered: z.boolean(),
  vatPeriod: z.enum(VAT_PERIODS),
  salesTypes: z.array(z.enum(SALES_TYPES)).max(8),
  expenseCategories: z.array(z.enum(EXPENSE_CATEGORIES)).max(8),
  summaryNote: z.string().trim().max(500).optional(),
});

export function defaultBusinessProfile(): BusinessProfile {
  return {
    entityType: "toiminimi",
    vatRegistered: false,
    vatPeriod: "month",
    salesTypes: ["ripsipalvelut"],
    expenseCategories: ["tarvikkeet"],
  };
}

/** One answer chip. Labels carry no emoji (V1); the icons live in the UI. */
export interface OnboardingChoice {
  label: string;
  /** Optional second line under the label. */
  detail?: string;
  value: ChipValue;
}

export type OnboardingStepId =
  | "entityType"
  | "vatRegistered"
  | "vatPeriod"
  | "salesTypes"
  | "expenseCategories";

/** One question of the chat-style onboarding. */
export interface OnboardingChatStep {
  id: OnboardingStepId;
  question: string;
  /** One short line under the question. */
  hint?: string;
  field: keyof BusinessProfile;
  chips: OnboardingChoice[];
  multiSelect?: boolean;
}

/** The assistant's first bubble, shown once above the first question. */
export const ONBOARDING_INTRO =
  "Hei! Muokataan LashKirja sinun yrityksellesi sopivaksi. Se vie noin minuutin.";

export const ONBOARDING_STEPS: OnboardingChatStep[] = [
  {
    id: "entityType",
    question: "Mikä on yritysmuotosi?",
    field: "entityType",
    chips: [
      { label: "Toiminimi", detail: "Yksityinen elinkeinonharjoittaja", value: "toiminimi" },
      { label: "Kevytyrittäjä", detail: "Laskutat laskutuspalvelun kautta", value: "kevytyrittaja" },
      { label: "Osakeyhtiö (Oy)", value: "oy" },
    ],
  },
  {
    id: "vatRegistered",
    question: "Oletko arvonlisäverorekisterissä?",
    hint: "Tästä riippuu, lasketaanko myynnistäsi ALV.",
    field: "vatRegistered",
    chips: [
      { label: "Kyllä, olen ALV-rekisterissä", value: true },
      { label: "En ole ALV-rekisterissä", value: false },
    ],
  },
  {
    id: "vatPeriod",
    question: "Kuinka usein ilmoitat ALV:n OmaVerossa?",
    field: "vatPeriod",
    chips: [
      { label: "Kuukausittain", detail: "Tavallisin", value: "month" },
      { label: "Neljännesvuosittain", detail: "Kolmen kuukauden välein", value: "quarter" },
      { label: "Vuosittain", value: "year" },
    ],
  },
  {
    id: "salesTypes",
    question: "Mitä yrityksesi myy?",
    hint: "Voit valita useita.",
    field: "salesTypes",
    multiSelect: true,
    chips: [
      { label: "Ripsienpidennykset ja huollot", value: "ripsipalvelut" },
      { label: "Kulmapalvelut", detail: "Laminointi ja värjäys", value: "kulmapalvelut" },
      { label: "Koulutukset ja kurssit", value: "koulutus" },
      { label: "Kauneustuotteiden myynti", value: "tuotemyynti" },
    ],
  },
  {
    id: "expenseCategories",
    question: "Mitkä ovat tavallisimmat kulusi?",
    hint: "Voit valita useita.",
    field: "expenseCategories",
    multiSelect: true,
    chips: [
      { label: "Tarvikkeet", detail: "Liimat, kuidut ja hoitotuotteet", value: "tarvikkeet" },
      { label: "Liiketilan vuokra", value: "vuokra" },
      { label: "Markkinointi ja ajanvaraus", value: "markkinointi" },
      { label: "Koulutus ja ammattikirjallisuus", value: "koulutuskulut" },
    ],
  },
];

/** Answers collected so far. Nothing is pre-selected: a missing key is unanswered. */
export interface OnboardingAnswers {
  entityType?: EntityType;
  vatRegistered?: boolean;
  vatPeriod?: (typeof VAT_PERIODS)[number];
  salesTypes?: string[];
  expenseCategories?: string[];
}

/**
 * The questions to ask, given the answers so far. The VAT period is only
 * asked of a VAT-registered business, so "no" makes the flow 4 questions
 * long instead of silently skipping a progress dot.
 */
export function onboardingSteps(answers: OnboardingAnswers): OnboardingChatStep[] {
  return ONBOARDING_STEPS.filter((step) => step.id !== "vatPeriod" || answers.vatRegistered !== false);
}

export function onboardingStep(id: OnboardingStepId): OnboardingChatStep {
  const step = ONBOARDING_STEPS.find((item) => item.id === id);
  if (!step) throw new Error(`Unknown onboarding step ${id}`);
  return step;
}

export function isStepAnswered(answers: OnboardingAnswers, id: OnboardingStepId): boolean {
  return answers[id] !== undefined;
}

/** Label of one choice value in a step, e.g. "Kevytyrittäjä" for "kevytyrittaja". */
export function choiceLabel(id: OnboardingStepId, value: ChipValue): string {
  return onboardingStep(id).chips.find((chip) => chip.value === value)?.label ?? String(value);
}

export const NO_SELECTION_LABEL = "Ei mitään näistä";

/** What the user's answer bubble (and the summary row) says for a step. */
export function answerText(id: OnboardingStepId, answers: OnboardingAnswers): string {
  const value = answers[id];
  if (value === undefined) return "";
  if (Array.isArray(value)) {
    return value.length === 0
      ? NO_SELECTION_LABEL
      : value.map((item) => choiceLabel(id, item)).join(", ");
  }
  return choiceLabel(id, value);
}

export const VAT_PERIOD_LABELS: Record<(typeof VAT_PERIODS)[number], string> = {
  month: "Kuukausittain",
  quarter: "Neljännesvuosittain",
  year: "Vuosittain",
};

export interface ProfileSummaryRow {
  id: OnboardingStepId;
  label: string;
  value: string;
}

/** The summary as label/value rows: localized, never raw ids, no invented defaults. */
export function profileSummaryRows(answers: OnboardingAnswers): ProfileSummaryRow[] {
  const rows: ProfileSummaryRow[] = [
    { id: "entityType", label: "Yritysmuoto", value: answerText("entityType", answers) },
    {
      id: "vatRegistered",
      label: "ALV-rekisteri",
      value: answers.vatRegistered === undefined ? "" : answers.vatRegistered ? "Kyllä" : "Ei",
    },
  ];
  if (answers.vatRegistered) {
    rows.push({
      id: "vatPeriod",
      label: "ALV-kausi",
      value: answers.vatPeriod ? VAT_PERIOD_LABELS[answers.vatPeriod] : "",
    });
  }
  rows.push(
    { id: "salesTypes", label: "Myynti", value: answerText("salesTypes", answers) },
    { id: "expenseCategories", label: "Kulut", value: answerText("expenseCategories", answers) }
  );
  return rows;
}

/** A complete profile from the answers, or null while a question is unanswered. */
export function profileFromAnswers(answers: OnboardingAnswers): BusinessProfile | null {
  const steps = onboardingSteps(answers);
  if (!steps.every((step) => isStepAnswered(answers, step.id))) return null;
  if (!answers.entityType || answers.vatRegistered === undefined) return null;
  return {
    entityType: answers.entityType,
    vatRegistered: answers.vatRegistered,
    // The column needs a value; it only matters for a VAT-registered business.
    vatPeriod: answers.vatRegistered ? answers.vatPeriod ?? "month" : "month",
    salesTypes: answers.salesTypes ?? [],
    expenseCategories: answers.expenseCategories ?? [],
  };
}

/** Keeps only answers that are valid values; a stale or tampered draft loses the rest. */
export function sanitizeAnswers(raw: unknown): OnboardingAnswers {
  if (!raw || typeof raw !== "object") return {};
  const input = raw as Record<string, unknown>;
  const answers: OnboardingAnswers = {};
  if (ENTITY_TYPES.includes(input.entityType as EntityType)) answers.entityType = input.entityType as EntityType;
  if (typeof input.vatRegistered === "boolean") answers.vatRegistered = input.vatRegistered;
  if (VAT_PERIODS.includes(input.vatPeriod as (typeof VAT_PERIODS)[number])) {
    answers.vatPeriod = input.vatPeriod as (typeof VAT_PERIODS)[number];
  }
  const list = (value: unknown, allowed: readonly string[]) =>
    Array.isArray(value) ? value.filter((item): item is string => allowed.includes(item as string)) : undefined;
  const sales = list(input.salesTypes, SALES_TYPES);
  if (sales) answers.salesTypes = [...new Set(sales)];
  const expenses = list(input.expenseCategories, EXPENSE_CATEGORIES);
  if (expenses) answers.expenseCategories = [...new Set(expenses)];
  return answers;
}

export function parseBusinessDetails(jsonStr?: string | null): BusinessProfile {
  const fallback = defaultBusinessProfile();
  if (!jsonStr) return fallback;
  try {
    const parsed = businessProfileSchema.safeParse(JSON.parse(jsonStr));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

/**
 * One-line profile context for the model prompts (receipt reading, mail
 * sync, the assistant). Same Finnish labels as the UI, and an empty list is
 * said to be empty instead of being replaced by an invented default.
 */
export function generateProfileSummary(profile: BusinessProfile): string {
  const entityName = choiceLabel("entityType", profile.entityType);
  const vatStatus = profile.vatRegistered
    ? `ALV-rekisterissä (kausi: ${
        profile.vatPeriod === "quarter"
          ? "neljännesvuosi"
          : profile.vatPeriod === "year"
          ? "vuosi"
          : "kuukausi"
      })`
    : "Ei ALV-rekisterissä (ALV 0 %)";

  const labels = (id: OnboardingStepId, values: string[] | undefined) =>
    (values ?? []).map((value) => choiceLabel(id, value)).join(", ") || "ei valintaa";

  return `Yritysmuoto: ${entityName}. ALV: ${vatStatus}. Myynti: ${labels("salesTypes", profile.salesTypes)}. Kulut: ${labels("expenseCategories", profile.expenseCategories)}.`;
}

export interface VatProfile {
  isSingleRate: boolean;
  defaultSalesRate: number;
  salesRates: { type: string; rate: number }[];
  isVatRegistered: boolean;
}

export function deriveVatProfile(profile: BusinessProfile): VatProfile {
  if (!profile.vatRegistered) {
    return {
      isSingleRate: true,
      defaultSalesRate: 0,
      salesRates: profile.salesTypes.map(type => ({ type, rate: 0 })),
      isVatRegistered: false,
    };
  }

  // Map known sales types to their Finnish VAT rates (2026 standard is 25.5%)
  const rates = profile.salesTypes.map(type => {
    // Currently, all options in the UI (ripsipalvelut, kulmapalvelut, tuotemyynti, koulutus)
    // map to the standard 25.5% rate for typical beauty businesses.
    return { type, rate: 25.5 };
  });

  const uniqueRates = new Set(rates.map(r => r.rate));

  return {
    isSingleRate: uniqueRates.size <= 1,
    defaultSalesRate: rates.length > 0 ? rates[0].rate : 25.5,
    salesRates: rates,
    isVatRegistered: true,
  };
}
