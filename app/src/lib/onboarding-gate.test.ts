import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryDraftStorage, resetDraftMemory, setDraftOwner } from "./draft-store";
import {
  ONBOARDING_SNOOZE_MS,
  clearOnboardingDraft,
  clearOnboardingSnooze,
  isOnboardingSnoozed,
  readOnboardingDraft,
  saveOnboardingDraft,
  snoozeOnboarding,
} from "./onboarding-gate";

const storage = memoryDraftStorage;

beforeEach(() => {
  resetDraftMemory();
  setDraftOwner("user-1", storage);
});

afterEach(() => {
  setDraftOwner(null, storage);
});

describe("onboarding gate", () => {
  it("snoozes for 24 hours and then asks again", () => {
    const now = 1_000_000;
    expect(isOnboardingSnoozed(now, storage)).toBe(false);
    snoozeOnboarding(now, storage);
    expect(isOnboardingSnoozed(now + 1, storage)).toBe(true);
    expect(isOnboardingSnoozed(now + ONBOARDING_SNOOZE_MS - 1, storage)).toBe(true);
    expect(isOnboardingSnoozed(now + ONBOARDING_SNOOZE_MS + 1, storage)).toBe(false);
    clearOnboardingSnooze(storage);
    expect(isOnboardingSnoozed(now + 1, storage)).toBe(false);
  });

  it("restores a draft so an app kill does not restart the flow", () => {
    const now = 2_000_000;
    saveOnboardingDraft(
      { answers: { entityType: "oy", vatRegistered: false }, done: ["entityType", "vatRegistered"] },
      now,
      storage
    );
    expect(readOnboardingDraft(now + 1, storage)).toEqual({
      answers: { entityType: "oy", vatRegistered: false },
      done: ["entityType", "vatRegistered"],
    });
    clearOnboardingDraft(storage);
    expect(readOnboardingDraft(now + 1, storage)).toBeNull();
  });

  it("drops unanswered, unknown and repeated steps from a stored thread", () => {
    const now = 3_000_000;
    saveOnboardingDraft(
      {
        answers: { entityType: "toiminimi" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        done: ["entityType", "entityType", "vatRegistered", "bogus" as any],
      },
      now,
      storage
    );
    expect(readOnboardingDraft(now, storage)?.done).toEqual(["entityType"]);
  });

  it("belongs to the signed-in user only", () => {
    const now = 4_000_000;
    snoozeOnboarding(now, storage);
    setDraftOwner("user-2", storage);
    expect(isOnboardingSnoozed(now + 1, storage)).toBe(false);
  });
});
