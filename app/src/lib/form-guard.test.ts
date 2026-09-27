import { describe, expect, it } from "vitest";
import {
  anyFormDirty,
  registerDirtySource,
  requestLeave,
  resetFormGuardForTests,
  setLeaveHandler,
} from "./form-guard";

describe("unsaved changes guard", () => {
  it("lets navigation through when no editor is dirty", () => {
    resetFormGuardForTests();
    let ran = false;
    requestLeave(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(anyFormDirty()).toBe(false);
  });

  it("asks before leaving a dirty invoice, customer, or receipt editor", () => {
    resetFormGuardForTests();
    const unregister = registerDirtySource("invoice:new", () => true);
    let proceeded = false;
    let asked = false;
    setLeaveHandler((proceed) => {
      asked = true;
      proceed();
    });
    requestLeave(() => {
      proceeded = true;
    });
    expect(asked).toBe(true);
    expect(proceeded).toBe(true);
    unregister();
    expect(anyFormDirty()).toBe(false);
  });

  it("does not treat an unregistered profile edit as a reason to ask", () => {
    resetFormGuardForTests();
    setLeaveHandler(() => {
      throw new Error("profile must not open the guard");
    });
    let ran = false;
    requestLeave(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
