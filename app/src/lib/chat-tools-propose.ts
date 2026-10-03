/**
 * The assistant's confirmed actions. A propose_* tool never writes the books:
 * it checks the request on the server and returns a proposal that is stored on
 * the reply (ChatMessage.proposalData) and shown as a card with Hyväksy /
 * Hylkää. Only the owner's Hyväksy (PATCH /api/ai/chat, chat-decision.ts)
 * applies it, through the same code the screens use: a draft invoice through
 * createInvoice, a receipt fix through the receipt edit (applyReceiptPatch).
 */
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { applyVatRules, createInvoice, toLineInputs } from "./sales-invoices";
import { computeInvoiceTotals, dueDateFor, InvoiceValidationError, MAX_PAYMENT_TERM_DAYS } from "./invoices";
import { customerSearchFields } from "./search";
import { categoryLabel, normalizeExtractedCategory, RECEIPT_CATEGORY_IDS } from "./receipt-categories";
import { parseVatDetails } from "./alv";
import { sameVatLines, vatLinesProblem } from "./receipt-vat";
import { assertPeriodOpen, PeriodLockedError } from "./period-lock";
import { AppError } from "./api-errors";
import { applyReceiptPatch, type ReceiptPatch } from "./receipt-update";
import { helsinkiCalendarDate, isoDateToUtc, isStrictIsoDate } from "./validation";
import { formatEur } from "./format";
import { detailHref } from "./routes";
import { centsToEuros, eurosToCents, isCentAmount } from "./money";
import { eur, exactName, fuzzyMatch, isoDay, ToolInputError } from "./chat-tools-shared";
import type { ChatTool, ToolContext } from "./chat-tools-read";

export interface InvoiceDraftLine {
  description: string;
  quantity: number;
  unit: string;
  /** Excluding VAT, exact euros ("12.50"). */
  unitPrice: string;
  /** Percent, e.g. 25.5. */
  vatRate: number;
  net: string;
}

export interface InvoiceDraftProposal {
  type: "invoice_draft";
  customerId: string;
  customerName: string;
  issueDate: string;
  dueDate: string;
  paymentTermDays: number;
  notes: string | null;
  lines: InvoiceDraftLine[];
  totals: { net: string; vat: string; gross: string };
  status?: "accepted" | "rejected";
  /** Set once accepted: the draft invoice that was created. */
  invoiceId?: string;
  invoiceNumber?: number;
  href?: string;
}

export interface ReceiptFieldChange {
  field: "vendor" | "date" | "totalAmount" | "vatDetails" | "category";
  /** Finnish field name for the card. */
  label: string;
  from: string;
  to: string;
}

export interface ReceiptUpdateProposal {
  type: "receipt_update";
  receiptId: string;
  receiptSummary: string;
  changes: ReceiptFieldChange[];
  /** Exactly what Hyväksy writes. */
  patch: ReceiptPatch;
  /** The receipt as it was when proposed: a change made since is a conflict, not overwritten. */
  expectedUpdatedAt: string;
  status?: "accepted" | "rejected";
  href?: string;
}

export type ChatActionProposal = InvoiceDraftProposal | ReceiptUpdateProposal;

export const ACTION_PROPOSAL_TYPES = ["invoice_draft", "receipt_update"] as const;

/** What the model is told after it proposed: the card is shown, nothing is done yet. */
const PROPOSED_NOTE =
  "Shown to the user as a card with Hyväksy / Hylkää. Nothing has been written: say it is a proposal waiting for their confirmation, never that it was done.";

/* ------------------------------ invoice draft ------------------------------ */

const invoiceDraftArgs = z
  .object({
    customer: z.string().trim().min(1).max(120),
    lines: z
      .array(
        z
          .object({
            description: z.string().trim().min(1).max(200),
            quantity: z.number().finite(),
            unitPrice: z.number().finite().refine(isCentAmount, "at most two decimals"),
            vatRate: z.number().finite().min(0).max(100).optional(),
            unit: z.string().trim().max(16).optional(),
          })
          .strict()
      )
      .min(1)
      .max(20),
    pricesIncludeVat: z.boolean().optional(),
    paymentTermDays: z.number().int().min(0).max(MAX_PAYMENT_TERM_DAYS).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();

function vatRateToPermille(rate: number): number {
  return Math.round(rate * 10);
}

async function resolveCustomer(userId: string, name: string) {
  const customers = await prisma.customer.findMany({
    where: { userId, archivedAt: null },
    select: { id: true, name: true, contactPerson: true, email: true, businessId: true, defaultPaymentTermDays: true },
    orderBy: { name: "asc" },
  });
  const exact = customers.filter((customer) => exactName(name, customer.name));
  if (exact.length === 1) return { customer: exact[0], candidates: [] as string[] };
  const loose = customers.filter((customer) => fuzzyMatch(name, ...customerSearchFields(customer)));
  if (loose.length === 1) return { customer: loose[0], candidates: [] as string[] };
  return { customer: null, candidates: (exact.length > 1 ? exact : loose).slice(0, 8).map((customer) => customer.name) };
}

const proposeInvoiceDraft: ChatTool = {
  definition: {
    type: "function",
    function: {
      name: "propose_invoice_draft",
      description:
        "Proposes a DRAFT sales invoice for an existing customer. Creates nothing: the user sees a card with the customer, lines and total and confirms with Hyväksy. Use only when the user asks for an invoice. Prices exclude VAT unless pricesIncludeVat is true. VAT rate defaults to 25.5 (0 for a seller outside the VAT register).",
      parameters: {
        type: "object",
        required: ["customer", "lines"],
        properties: {
          customer: { type: "string", description: "Existing customer's name as the user said it." },
          lines: {
            type: "array",
            items: {
              type: "object",
              required: ["description", "quantity", "unitPrice"],
              properties: {
                description: { type: "string" },
                quantity: { type: "number" },
                unitPrice: { type: "number", description: "Euros per unit." },
                vatRate: { type: "number", description: "Percent: 25.5, 13.5, 10 or 0." },
                unit: { type: "string", description: "Default kpl." },
              },
            },
          },
          pricesIncludeVat: { type: "boolean" },
          paymentTermDays: { type: "integer", description: "Default the customer's own term." },
          notes: { type: "string" },
        },
      },
    },
  },
  async run(ctx, raw) {
    const parsed = invoiceDraftArgs.safeParse(raw ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ToolInputError(`Invalid argument ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`);
    }
    const args = parsed.data;
    const { customer, candidates } = await resolveCustomer(ctx.userId, args.customer);
    if (!customer) {
      return {
        ok: false,
        error: candidates.length
          ? "Several customers match. Ask the user which one they mean."
          : "No customer with that name. Ask the user to check the name, or to add the customer under Asiakkaat first.",
        candidates,
      };
    }
    const issueDate = helsinkiCalendarDate(ctx.now);
    const lines = args.lines.map((line) => {
      const rate = line.vatRate ?? 25.5;
      const permille = vatRateToPermille(rate);
      // A price with VAT in it becomes the net price the invoice stores (to the cent).
      const unitPriceCents = args.pricesIncludeVat
        ? Math.round((eurosToCents(line.unitPrice) * 1000) / (1000 + permille))
        : eurosToCents(line.unitPrice);
      return { description: line.description, quantity: line.quantity, unit: line.unit, unitPrice: centsToEuros(unitPriceCents), vatRate: rate };
    });
    let lineInputs;
    try {
      lineInputs = await applyVatRules(ctx.userId, toLineInputs(lines), issueDate);
    } catch (error) {
      if (error instanceof AppError) return { ok: false, error: error.message };
      throw error;
    }
    let totals;
    try {
      totals = computeInvoiceTotals(lineInputs);
    } catch (error) {
      if (error instanceof InvoiceValidationError) return { ok: false, error: error.message };
      throw error;
    }
    try {
      await assertPeriodOpen(ctx.userId, [isoDateToUtc(issueDate)]);
    } catch (error) {
      if (error instanceof PeriodLockedError) return { ok: false, error: error.message };
      throw error;
    }
    const term = args.paymentTermDays ?? customer.defaultPaymentTermDays;
    const proposal: InvoiceDraftProposal = {
      type: "invoice_draft",
      customerId: customer.id,
      customerName: customer.name,
      issueDate,
      dueDate: isoDay(dueDateFor(isoDateToUtc(issueDate), term))!,
      paymentTermDays: term,
      notes: args.notes?.trim() || null,
      lines: lineInputs.map((line, index) => ({
        description: line.description,
        quantity: line.quantityMilli / 1000,
        unit: line.unit,
        unitPrice: eur(line.unitPriceCents),
        vatRate: line.vatRatePermille / 10,
        net: eur(totals.lines[index].netCents),
      })),
      totals: { net: eur(totals.netCents), vat: eur(totals.vatCents), gross: eur(totals.grossCents) },
    };
    return { ok: true, proposal, note: PROPOSED_NOTE };
  },
};

/** Hyväksy on an invoice_draft: the draft is created in the caller's transaction, exactly as proposed. */
export async function acceptInvoiceDraft(userId: string, proposal: InvoiceDraftProposal, tx: Prisma.TransactionClient) {
  const invoice = await createInvoice(
    userId,
    {
      customerId: proposal.customerId,
      issueDate: proposal.issueDate,
      dueDate: proposal.dueDate,
      notes: proposal.notes,
      lines: proposal.lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: Number(line.unitPrice),
        vatRate: line.vatRate,
      })),
    },
    tx
  );
  // The VAT rules could have changed since (registration, a rate): never create another total than was shown.
  if (eur(eurosToCents(invoice.gross)) !== proposal.totals.gross) {
    throw new AppError("Laskun summa olisi muuttunut ehdotuksesta. Pyydä uusi ehdotus.", "PROPOSAL_STALE", 409);
  }
  return { invoiceId: invoice.id, invoiceNumber: invoice.number, href: detailHref("invoice", invoice.id) };
}

/* ------------------------------ receipt update ------------------------------ */

const receiptUpdateArgs = z
  .object({
    receiptId: z.string().trim().min(1).max(64),
    category: z.string().trim().max(100).optional(),
    vendor: z.string().trim().min(1).max(300).optional(),
    date: z.string().trim().optional(),
    totalAmount: z.number().finite().nonnegative().refine(isCentAmount, "at most two decimals").optional(),
    vatLines: z
      .array(z.object({ rate: z.number().finite().min(0).max(100), amount: z.number().finite().nonnegative().refine(isCentAmount, "at most two decimals") }).strict())
      .max(5)
      .optional(),
  })
  .strict();

function dayText(date: Date | string | null): string {
  if (!date) return "–";
  const iso = typeof date === "string" ? date : date.toISOString().slice(0, 10);
  const [year, month, day] = iso.split("-").map(Number);
  return `${day}.${month}.${year}`;
}

function vatText(lines: Array<{ rate: number; amount: number }>): string {
  if (lines.length === 0) return "–";
  return lines.map((line) => `${String(line.rate).replace(".", ",")} %: ${formatEur(line.amount)}`).join(", ");
}

const proposeReceiptUpdate: ChatTool = {
  definition: {
    type: "function",
    function: {
      name: "propose_receipt_update",
      description:
        "Proposes a correction to one receipt (category, vendor, date, total amount, VAT lines). Changes nothing: the user sees each field's old and new value and confirms with Hyväksy. Get the receipt id from search_receipts first. A receipt in a closed period cannot be changed.",
      parameters: {
        type: "object",
        required: ["receiptId"],
        properties: {
          receiptId: { type: "string" },
          category: { type: "string", description: `One of: ${RECEIPT_CATEGORY_IDS.join(", ")}` },
          vendor: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD" },
          totalAmount: { type: "number", description: "Total including VAT, euros." },
          vatLines: {
            type: "array",
            description: "The whole VAT breakdown: one line per rate, amount = VAT in euros.",
            items: { type: "object", required: ["rate", "amount"], properties: { rate: { type: "number" }, amount: { type: "number" } } },
          },
        },
      },
    },
  },
  async run(ctx, raw) {
    const parsed = receiptUpdateArgs.safeParse(raw ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ToolInputError(`Invalid argument ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`);
    }
    const args = parsed.data;
    const receipt = await prisma.receipt.findFirst({ where: { id: args.receiptId, userId: ctx.userId } });
    if (!receipt) return { ok: false, error: "No such receipt. Use an id from search_receipts." };

    const patch: ReceiptPatch = {};
    const changes: ReceiptFieldChange[] = [];
    if (args.category !== undefined) {
      const category = normalizeExtractedCategory(args.category);
      if (!category) return { ok: false, error: `Unknown category. Use one of: ${RECEIPT_CATEGORY_IDS.join(", ")}` };
      if (category !== receipt.category) {
        patch.category = category;
        changes.push({ field: "category", label: "Luokka", from: receipt.category ? categoryLabel(receipt.category) : "–", to: categoryLabel(category) });
      }
    }
    if (args.vendor !== undefined && args.vendor !== (receipt.vendor ?? "")) {
      patch.vendor = args.vendor;
      changes.push({ field: "vendor", label: "Myyjä", from: receipt.vendor ?? "–", to: args.vendor });
    }
    if (args.date !== undefined) {
      if (!isStrictIsoDate(args.date)) return { ok: false, error: "date must be YYYY-MM-DD." };
      if (args.date !== isoDay(receipt.date)) {
        patch.date = args.date;
        changes.push({ field: "date", label: "Päivä", from: dayText(receipt.date), to: dayText(args.date) });
      }
    }
    const storedTotal = receipt.totalAmountCents == null ? null : centsToEuros(receipt.totalAmountCents);
    if (args.totalAmount !== undefined && args.totalAmount !== storedTotal) {
      patch.totalAmount = args.totalAmount;
      changes.push({ field: "totalAmount", label: "Summa", from: storedTotal == null ? "–" : formatEur(storedTotal), to: formatEur(args.totalAmount) });
    }
    const storedLines = (parseVatDetails(receipt.vatDetails) ?? []).map((line) => ({ rate: line.rate, amount: centsToEuros(line.amountCents) }));
    if (args.vatLines !== undefined && !sameVatLines(args.vatLines, storedLines)) {
      patch.vatDetails = args.vatLines;
      changes.push({ field: "vatDetails", label: "ALV", from: vatText(storedLines), to: vatText(args.vatLines) });
    }
    if (changes.length === 0) return { ok: false, error: "Nothing would change: the receipt already has these values." };

    // The same rules the receipt edit enforces, checked now so a proposal that cannot be applied is never shown.
    if (patch.vatDetails !== undefined || patch.totalAmount !== undefined) {
      const lines = patch.vatDetails ?? storedLines;
      const total = patch.totalAmount !== undefined ? patch.totalAmount : storedTotal;
      const problem = vatLinesProblem(lines ?? [], total, patch.vatDetails !== undefined);
      if (problem) return { ok: false, error: problem };
    }
    try {
      await assertPeriodOpen(ctx.userId, [receipt.date, patch.date ? isoDateToUtc(patch.date) : null]);
    } catch (error) {
      if (error instanceof PeriodLockedError) return { ok: false, error: error.message };
      throw error;
    }

    const summaryParts = [receipt.vendor || receipt.fileName, dayText(receipt.date)];
    if (storedTotal != null) summaryParts.push(formatEur(storedTotal));
    const proposal: ReceiptUpdateProposal = {
      type: "receipt_update",
      receiptId: receipt.id,
      receiptSummary: summaryParts.join(" · "),
      changes,
      patch,
      expectedUpdatedAt: receipt.updatedAt.toISOString(),
    };
    // Exact euros for the model (and the honesty guard): the card's text is formatted for people.
    const amounts = {
      ...(patch.totalAmount != null ? { newTotal: eur(eurosToCents(patch.totalAmount)), oldTotal: storedTotal == null ? null : eur(receipt.totalAmountCents!) } : {}),
      ...(patch.vatDetails ? { newVat: patch.vatDetails.map((line) => ({ rate: line.rate, amount: eur(eurosToCents(line.amount)) })) } : {}),
    };
    return { ok: true, proposal, ...amounts, note: PROPOSED_NOTE };
  },
};

/** Hyväksy on a receipt_update: written through the receipt edit, in the caller's transaction. */
export async function acceptReceiptUpdate(userId: string, proposal: ReceiptUpdateProposal, tx: Prisma.TransactionClient) {
  await applyReceiptPatch(userId, proposal.receiptId, proposal.patch, {
    expected: new Date(proposal.expectedUpdatedAt),
    db: tx,
  });
  return { href: detailHref("receipt", proposal.receiptId) };
}

export const PROPOSAL_TOOLS: ChatTool[] = [proposeInvoiceDraft, proposeReceiptUpdate];

export type { ToolContext };
