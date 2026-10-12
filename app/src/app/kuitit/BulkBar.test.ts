import { describe, expect, it } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BulkBar } from "./BulkBar";
import { SelectableRow } from "@/components/SelectableRow";
import { purchaseBulkLabels } from "@/lib/purchase-bulk";

const base = {
  visible: true,
  count: 3,
  busy: false,
  approveBusy: false,
  approvableCount: 2,
  onCancel: () => {},
  onApproveRequest: () => {},
  onDeleteRequest: () => {},
};
const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(BulkBar, { ...base, ...props }));

describe("BulkBar", () => {
  it("keeps the Kuitit buttons and name when no custom actions are given", () => {
    const out = html({});
    expect(out).toContain('aria-label="Valitut kuitit"');
    expect(out).toContain("3 valittu");
    expect(out).toContain("Poista");
    expect(out).toContain("max-w-sm");
  });

  it("shows a list's own actions instead (Ostolaskut), each with its count", () => {
    const out = html({
      label: "Valitut ostolaskut",
      actions: createElement("button", { type: "button" }, purchaseBulkLabels.pay(2)),
    });
    expect(out).toContain('aria-label="Valitut ostolaskut"');
    expect(out).toContain("Merkitse maksetuiksi (2)");
    expect(out).toContain("Peruuta");
    expect(out).not.toContain(">Poista<");
    expect(out).toContain("flex-wrap");
  });

  it("is not rendered while nothing is selected", () => {
    expect(html({ visible: false, count: 0 })).toBe("");
  });
});

describe("SelectableRow", () => {
  it("wraps a row with the round checkbox and reflects the selection", () => {
    const render = (selected: boolean) =>
      renderToStaticMarkup(
        createElement(
          SelectableRow,
          { selected, onToggle: () => {}, label: "Valitse Telia" } as ComponentProps<typeof SelectableRow>,
          createElement("p", null, "Telia")
        )
      );
    expect(render(false)).toContain('aria-label="Valitse Telia"');
    expect(render(false)).not.toContain('checked=""');
    expect(render(true)).toContain('checked=""');
    expect(render(true)).toContain("Telia");
  });
});
