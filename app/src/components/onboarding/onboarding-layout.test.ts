import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * F20: on the multi-select steps the newest question hid behind the answer
 * panel. The panel swaps to the next step's (taller) choices after the stage is
 * already "ready", so the thread must be anchored to its bottom again when the
 * panel changes, and the choices must be compact on a short phone. There is no
 * DOM harness in the unit suite; these assertions pin the two decisions in source.
 */
const dir = __dirname;
const chat = readFileSync(path.join(dir, "OnboardingChat.tsx"), "utf8");
const css = readFileSync(path.join(dir, "onboarding.module.css"), "utf8");

describe("onboarding keeps the question above its choices (F20)", () => {
  it("scrolls the thread to the bottom again when the panel's choices change", () => {
    const effect = /thread\.scrollTo\(\{ top: thread\.scrollHeight[\s\S]*?\}, \[([^\]]*)\]\);/.exec(chat);
    expect(effect, "the scroll-to-bottom effect").not.toBeNull();
    expect(effect![1]).toContain("panel.generation");
    expect(effect![1]).toContain("stage");
  });

  it("makes the choice rows compact on a short phone", () => {
    expect(css).toMatch(/@media \(max-height: 640px\)[\s\S]*\.choiceGroup[\s\S]*min-height: 44px/);
    expect(chat).toContain("styles.choiceGroup");
    expect(chat).toContain("styles.doneButton");
  });
});
