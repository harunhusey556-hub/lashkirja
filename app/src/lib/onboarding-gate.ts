/**
 * Client-side state of the onboarding gate: the in-progress draft (so an app
 * kill does not restart the flow) and the 24 h snooze behind "Ohita nyt".
 *
 * Both live in the per-user draft store, so they are scoped to the signed-in
 * user and removed on sign-out. Every storage access is guarded there; when
 * storage is unavailable the gate simply behaves as if nothing was saved.
 */
import { clearDraft, readDraft, saveDraft, type DraftStorage } from "./draft-store";
import { sanitizeAnswers, type OnboardingAnswers, type OnboardingStepId } from "./onboarding";

export const ONBOARDING_DRAFT_KEY = "onboarding-draft.v1";
export const ONBOARDING_SNOOZE_KEY = "onboarding-snoozed-until";
export const ONBOARDING_SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface OnboardingDraft {
  answers: OnboardingAnswers;
  /** The answered questions in thread order. */
  done: OnboardingStepId[];
}

const STEP_IDS: OnboardingStepId[] = [
  "entityType",
  "vatRegistered",
  "vatPeriod",
  "salesTypes",
  "expenseCategories",
];

type Storage = DraftStorage | null | undefined;

export function saveOnboardingDraft(draft: OnboardingDraft, now = Date.now(), storage?: Storage): void {
  saveDraft(ONBOARDING_DRAFT_KEY, draft, now, storage);
}

export function readOnboardingDraft(now = Date.now(), storage?: Storage): OnboardingDraft | null {
  const envelope = readDraft<OnboardingDraft>(ONBOARDING_DRAFT_KEY, now, storage);
  if (!envelope) return null;
  const answers = sanitizeAnswers(envelope.value?.answers);
  const rawDone = Array.isArray(envelope.value?.done) ? envelope.value.done : [];
  const done: OnboardingStepId[] = [];
  for (const id of rawDone) {
    // Only answered, known, unique ids survive, in their original order.
    if (STEP_IDS.includes(id) && answers[id] !== undefined && !done.includes(id)) done.push(id);
  }
  return { answers, done };
}

export function clearOnboardingDraft(storage?: Storage): void {
  clearDraft(ONBOARDING_DRAFT_KEY, storage);
}

/** "Ohita nyt": hide the gate for 24 h. No profile values are assumed or saved. */
export function snoozeOnboarding(now = Date.now(), storage?: Storage): number {
  const until = now + ONBOARDING_SNOOZE_MS;
  saveDraft(ONBOARDING_SNOOZE_KEY, until, now, storage);
  return until;
}

export function isOnboardingSnoozed(now = Date.now(), storage?: Storage): boolean {
  const envelope = readDraft<number>(ONBOARDING_SNOOZE_KEY, now, storage);
  return Boolean(envelope && typeof envelope.value === "number" && envelope.value > now);
}

export function clearOnboardingSnooze(storage?: Storage): void {
  clearDraft(ONBOARDING_SNOOZE_KEY, storage);
}
