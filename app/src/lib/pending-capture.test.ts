import { afterEach, describe, expect, it } from "vitest";
import {
  PENDING_CAPTURE_ROUTES,
  clearPendingCapture,
  hasPendingCapture,
  stashPendingCapture,
  takePendingCapture,
} from "./pending-capture";

const photo = () => new File([new Uint8Array([1, 2, 3])], "kuitti.jpg", { type: "image/jpeg" });

afterEach(() => clearPendingCapture());

describe("pending capture hand-off", () => {
  it("hands the files over exactly once", () => {
    const file = photo();
    stashPendingCapture("receipt", [file]);
    expect(hasPendingCapture("receipt")).toBe(true);
    expect(takePendingCapture("receipt")).toEqual([file]);
    expect(takePendingCapture("receipt")).toBeNull();
    expect(hasPendingCapture("receipt")).toBe(false);
  });

  it("keeps receipt and statement stashes apart", () => {
    stashPendingCapture("statement", [photo()]);
    expect(takePendingCapture("receipt")).toBeNull();
    expect(takePendingCapture("statement")).toHaveLength(1);
  });

  it("drops a stash older than two minutes", () => {
    stashPendingCapture("receipt", [photo()], 1_000);
    expect(takePendingCapture("receipt", 1_000 + 2 * 60 * 1000 + 1)).toBeNull();
  });

  it("routes the camera to the receipt editor with from=camera", () => {
    expect(PENDING_CAPTURE_ROUTES.receipt).toBe("/kuitit/uusi?from=camera");
    expect(PENDING_CAPTURE_ROUTES.statement).toBe("/pankki/tapahtumat?import=1");
  });
});
