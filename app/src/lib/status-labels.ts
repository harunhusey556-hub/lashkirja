import type { InvoiceDisplayStatus } from "./invoices";

/** One place for status wording and colour. Words match what the app already shows. */
export type Tone = "neutral" | "accent" | "danger" | "success" | "warning";
type Label = { label: string; tone: Tone };

export const SALES_STATUS: Record<InvoiceDisplayStatus, Label> = {
  draft: { label: "Luonnos", tone: "neutral" },
  sent: { label: "Lähetetty", tone: "accent" },
  overdue: { label: "Myöhässä", tone: "danger" },
  paid: { label: "Maksettu", tone: "success" },
  credited: { label: "Hyvitetty", tone: "neutral" },
};

export const PURCHASE_STATUS: Record<"open" | "overdue" | "paid" | "cancelled", Label> = {
  open: { label: "Avoin", tone: "accent" },
  overdue: { label: "Myöhässä", tone: "danger" },
  paid: { label: "Maksettu", tone: "success" },
  cancelled: { label: "Mitätöity", tone: "neutral" },
};
