import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KotiFallback } from "./DashboardClient";

describe("C-3: Koti's static first frame already has the title block", () => {
  it("renders the title row with the month stepper above the skeleton", () => {
    const out = renderToStaticMarkup(createElement(KotiFallback));
    const header = out.indexOf("<header");
    const skeleton = out.indexOf("Ladataan kuukauden tilannetta");
    expect(header).toBeGreaterThanOrEqual(0);
    expect(out).toContain("<h1");
    expect(out).toContain("Edellinen kuukausi");
    expect(skeleton).toBeGreaterThan(header);
  });
});
