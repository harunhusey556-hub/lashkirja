/**
 * The assistant's read tools. Every one is computed here, on the server, for
 * the signed-in owner only: the model chooses a tool and its filters, never
 * an owner, a query or a figure. Money is exact (integer cents to "1234.56").
 * Lists are paged with an opaque cursor. Each tool reuses the code its screen
 * uses (Raportit, ALV-ilmoitus, Pankki, Koti / Kuukauden sulku), so the
 * assistant and the screen cannot disagree.
 */
import { z } from "zod";
import { prisma } from "./db";
import { buildProfitLoss, type CategoryRow } from "./reports";
import { alvReportOf, loadAlvPeriodSources } from "./alv-period";
import { parseVatDetails } from "./alv";
import { categoryLabel, isKnownCategory, normalizeExtractedCategory } from "./receipt-categories";
import { daysOverdue, displayStatus, openPosition, overdueBefore, type InvoiceStatus } from "./invoices";
import { customerSearchFields } from "./search";
import { getBankPosition } from "./bank-position";
import { alvPeriodBoundsUtc, alvPeriodSchema, helsinkiCalendarDate, helsinkiMonthKey, isoDateToUtc } from "./validation";
import { getVatFiling, countPendingReceipts } from "./vat-filing";
import { vatChangedSinceFiling, vatFilingState, vatNothingToPay } from "./vat-due";
import { vatPeriodEndingIn, vatPeriodKey, vatPeriodKindOf } from "./vat-deadline";
import { getLockedThrough, isMonthLocked } from "./period-lock";
import { monthCloseSubtitle, type MonthCloseFacts } from "./month-close";
import { alvDrillHref } from "./report-drill";
import { detailHref } from "./routes";
import { buildDashboardItems, type DashboardItem } from "@/app/api/dashboard/items";
import {
  eur,
  eurOf,
  fuzzyMatch,
  isoDay,
  pageOf,
  previousPeriods,
  resolvePeriod,
  ToolInputError,
  type ResolvedPeriod,
} from "./chat-tools-shared";
import type { ChatToolDefinition } from "./chat-provider";

export interface ToolContext {
  userId: string;
  now: Date;
}

export interface ChatTool {
  definition: ChatToolDefinition;
  run: (ctx: ToolContext, args: unknown) => Promise<Record<string, unknown>>;
}

/** Scans at most this many rows per question; more is said, never silently cut. */
const SCAN_LIMIT = 2000;

const periodProps = {
  period: { type: "string", description: "One period: YYYY-MM (month), YYYY-Qn (quarter) or YYYY (year)." },
  from: { type: "string", description: "First month of a range, YYYY-MM (inclusive). Use with 'to' instead of 'period'." },
  to: { type: "string", description: "Last month of a range, YYYY-MM (inclusive). Defaults to the current month." },
} as const;

const pageProps = {
  cursor: { type: "string", description: "nextCursor from the previous page, unchanged." },
  limit: { type: "integer", description: "Rows per page, 1-25 (default 10)." },
} as const;

const periodArgs = {
  period: z.string().max(20).optional(),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
};
const pageArgs = { cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(25).optional() };

function parseArgs<T extends z.ZodTypeAny>(schema: T, args: unknown): z.infer<T> {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ToolInputError(`Invalid argument ${issue?.path.join(".") || ""}: ${issue?.message ?? "invalid"}`.trim());
  }
  return parsed.data;
}

function periodOut(period: ResolvedPeriod | null) {
  return period ? { key: period.key, from: period.fromMonth, to: period.toMonth } : null;
}

const sumCents = (rows: Array<{ amountCents: number }>) => rows.reduce((sum, row) => sum + row.amountCents, 0);

/* ----------------------------- search_invoices ----------------------------- */

const invoiceArgs = z
  .object({
    customer: z.string().trim().max(120).optional(),
    status: z.enum(["open", "overdue", "paid", "draft", "credited", "all"]).optional(),
    ...periodArgs,
    ...pageArgs,
  })
  .strict();

const searchInvoices: ChatTool = {
  definition: {
    type: "function",
    function: {
      name: "search_invoices",
      description:
        "Sales invoices (myyntilaskut) of the signed-in business. Filter by customer name (typed loosely: part of the name, any case, an inflected form or a small typo is fine), status and issue-date period. Returns totals over every match and one page of rows.",
      parameters: {
        type: "object",
        properties: {
          customer: { type: "string", description: "Customer name as the user said it." },
          status: {
            type: "string",
            enum: ["open", "overdue", "paid", "draft", "credited", "all"],
            description: "open = sent and not fully paid (overdue included); overdue = past due and unpaid.",
          },
          ...periodProps,
          ...pageProps,
        },
      },
    },
  },
  async run(ctx, raw) {
    const args = parseArgs(invoiceArgs, raw);
    const period = resolvePeriod(args, ctx.now);
    const where: Record<string, unknown> = { userId: ctx.userId };
    if (period) where.issueDate = { gte: period.start, lt: period.end };
    let matchedCustomers: string[] | undefined;
    if (args.customer) {
      const customers = await prisma.customer.findMany({
        where: { userId: ctx.userId },
        select: { id: true, name: true, contactPerson: true, email: true, businessId: true },
      });
      const hits = customers.filter((customer) => fuzzyMatch(args.customer, ...customerSearchFields(customer)));
      matchedCustomers = hits.map((customer) => customer.name);
      where.customerId = { in: hits.map((customer) => customer.id) };
    }
    const status = args.status ?? "all";
    if (status === "open") Object.assign(where, { status: "sent", documentKind: "invoice" });
    else if (status === "overdue") Object.assign(where, { status: "sent", documentKind: "invoice", dueDate: { lt: overdueBefore(ctx.now) } });
    else if (status === "paid") Object.assign(where, { status: "paid", documentKind: "invoice" });
    else if (status === "draft") where.status = "draft";
    else if (status === "credited") where.OR = [{ status: "credited" }, { documentKind: "credit_note" }];

    const rows = await prisma.salesInvoice.findMany({
      where,
      select: {
        id: true,
        number: true,
        status: true,
        documentKind: true,
        issueDate: true,
        dueDate: true,
        currency: true,
        grossCents: true,
        closedReason: true,
        customer: { select: { name: true } },
        payments: { select: { amountCents: true } },
      },
      orderBy: [{ issueDate: "desc" }, { number: "desc" }],
      take: SCAN_LIMIT + 1,
    });
    const scanned = rows.slice(0, SCAN_LIMIT).map((row) => {
      const position = openPosition({ status: row.status, grossCents: row.grossCents, paidCents: sumCents(row.payments), closedReason: row.closedReason });
      return { row, position, shown: displayStatus({ status: row.status as InvoiceStatus, dueDate: row.dueDate, documentKind: row.documentKind }, ctx.now) };
    });
    const matches = status === "open" || status === "overdue" ? scanned.filter((entry) => entry.position.collectible) : scanned;
    const eurRows = matches.filter((entry) => entry.row.currency === "EUR");
    const page = pageOf(matches, args.cursor, args.limit);
    return {
      ok: true,
      period: periodOut(period),
      status,
      ...(matchedCustomers ? { matchedCustomers } : {}),
      total: {
        count: matches.length,
        gross: eur(eurRows.reduce((sum, entry) => sum + entry.row.grossCents, 0)),
        open: eur(eurRows.reduce((sum, entry) => sum + (entry.position.collectible ? entry.position.openCents : 0), 0)),
        ...(eurRows.length < matches.length ? { notInEurCount: matches.length - eurRows.length } : {}),
        ...(rows.length > SCAN_LIMIT ? { scanLimitReached: true } : {}),
      },
      items: page.items.map(({ row, position, shown }) => ({
        id: row.id,
        number: row.number,
        kind: row.documentKind === "credit_note" ? "credit_note" : "invoice",
        customer: row.customer.name,
        status: shown,
        issueDate: isoDay(row.issueDate),
        dueDate: isoDay(row.dueDate),
        currency: row.currency,
        gross: eur(row.grossCents),
        open: eur(position.collectible ? position.openCents : 0),
        ...(shown === "overdue" ? { daysOverdue: daysOverdue(row.dueDate, ctx.now) } : {}),
        href: detailHref("invoice", row.id),
      })),
      nextCursor: page.nextCursor,
    };
  },
};

/* ----------------------------- search_receipts ----------------------------- */

const receiptArgs = z
  .object({
    vendor: z.string().trim().max(120).optional(),
    category: z.string().trim().max(100).optional(),
    type: z.enum(["meno", "tulo"]).optional(),
    missingVat: z.boolean().optional(),
    status: z.enum(["approved", "pending", "all"]).optional(),
    ...periodArgs,
    ...pageArgs,
  })
  .strict();

const searchReceipts: ChatTool = {
  definition: {
    type: "function",
    function: {
      name: "search_receipts",
      description:
        "Receipts (kuitit) of the signed-in business: expenses (type meno) and income (type tulo). Filter by vendor (loose match), category id, type, receipt-date period, missing VAT breakdown and review status. Returns totals over every match and one page of rows with their ids.",
      parameters: {
        type: "object",
        properties: {
          vendor: { type: "string", description: "Vendor or shop name as the user said it." },
          category: { type: "string", description: "Category id, e.g. tarvikkeet, vuokra, sähkö, puhelin/netti, ohjelmistot, polttoaine, markkinointi, muut." },
          type: { type: "string", enum: ["meno", "tulo"] },
          missingVat: { type: "boolean", description: "true: only receipts without a VAT breakdown." },
          status: { type: "string", enum: ["approved", "pending", "all"], description: "Default all (rejected receipts are never included)." },
          ...periodProps,
          ...pageProps,
        },
      },
    },
  },
  async run(ctx, raw) {
    const args = parseArgs(receiptArgs, raw);
    const period = resolvePeriod(args, ctx.now);
    const where: Record<string, unknown> = { userId: ctx.userId };
    const status = args.status ?? "all";
    where.reviewStatus = status === "all" ? { not: "rejected" } : status;
    if (period) where.date = { gte: period.start, lt: period.end };
    if (args.type) where.type = args.type;
    if (args.category) {
      const category = normalizeExtractedCategory(args.category);
      if (!category) throw new ToolInputError(`Unknown category '${args.category}'.`);
      where.category = category;
    }
    if (args.missingVat) where.OR = [{ vatDetails: null }, { vatDetails: "" }, { vatDetails: "[]" }];

    const rows = await prisma.receipt.findMany({
      where,
      select: { id: true, vendor: true, fileName: true, date: true, totalAmountCents: true, vatDetails: true, category: true, type: true, reviewStatus: true },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      take: SCAN_LIMIT + 1,
    });
    const matches = rows
      .slice(0, SCAN_LIMIT)
      .filter((row) => !args.vendor || fuzzyMatch(args.vendor, row.vendor, row.fileName))
      .map((row) => {
        const lines = parseVatDetails(row.vatDetails);
        return { row, lines, vatCents: lines ? lines.reduce((sum, line) => sum + Math.abs(line.amountCents), 0) : null };
      });
    const page = pageOf(matches, args.cursor, args.limit);
    const signed = (entry: (typeof matches)[number]) => entry.row.totalAmountCents ?? 0;
    return {
      ok: true,
      period: periodOut(period),
      total: {
        count: matches.length,
        expenses: eur(matches.filter((entry) => entry.row.type !== "tulo").reduce((sum, entry) => sum + Math.abs(signed(entry)), 0)),
        income: eur(matches.filter((entry) => entry.row.type === "tulo").reduce((sum, entry) => sum + Math.abs(signed(entry)), 0)),
        vat: eur(matches.reduce((sum, entry) => sum + (entry.vatCents ?? 0), 0)),
        missingVatCount: matches.filter((entry) => !entry.lines).length,
        withoutAmountCount: matches.filter((entry) => entry.row.totalAmountCents == null).length,
        ...(rows.length > SCAN_LIMIT ? { scanLimitReached: true } : {}),
      },
      items: page.items.map(({ row, lines, vatCents }) => ({
        id: row.id,
        vendor: row.vendor ?? row.fileName,
        date: isoDay(row.date),
        type: row.type,
        gross: row.totalAmountCents == null ? null : eur(Math.abs(row.totalAmountCents)),
        vat: vatCents == null ? null : eur(vatCents),
        vatLines: lines ? lines.map((line) => ({ rate: line.rate, amount: eur(Math.abs(line.amountCents)) })) : null,
        category: row.category,
        categoryLabel: row.category && isKnownCategory(row.category) ? categoryLabel(row.category) : row.category,
        reviewStatus: row.reviewStatus,
        missingVat: !lines,
        href: detailHref("receipt", row.id),
      })),
      nextCursor: page.nextCursor,
    };
  },
};

/* ------------------------- search_purchase_invoices ------------------------- */

const purchaseArgs = z
  .object({
    supplier: z.string().trim().max(120).optional(),
    status: z.enum(["open", "overdue", "paid", "cancelled", "all"]).optional(),
    ...periodArgs,
    ...pageArgs,
  })
  .strict();

const searchPurchaseInvoices: ChatTool = {
  definition: {
    type: "function",
    function: {
      name: "search_purchase_invoices",
      description:
        "Purchase invoices (ostolaskut, bills the business owes). Filter by supplier (loose match), status and invoice-date period. Returns totals over every match and one page of rows.",
      parameters: {
        type: "object",
        properties: {
          supplier: { type: "string" },
          status: { type: "string", enum: ["open", "overdue", "paid", "cancelled", "all"], description: "open includes overdue." },
          ...periodProps,
          ...pageProps,
        },
      },
    },
  },
  async run(ctx, raw) {
    const args = parseArgs(purchaseArgs, raw);
    const period = resolvePeriod(args, ctx.now);
    const status = args.status ?? "all";
    const where: Record<string, unknown> = { userId: ctx.userId };
    if (period) where.issueDate = { gte: period.start, lt: period.end };
    if (status === "open") where.status = "open";
    else if (status === "overdue") Object.assign(where, { status: "open", dueDate: { lt: overdueBefore(ctx.now) } });
    else if (status !== "all") where.status = status;
    const rows = await prisma.purchaseInvoice.findMany({
      where,
      select: {
        id: true,
        supplierName: true,
        invoiceNumber: true,
        issueDate: true,
        dueDate: true,
        status: true,
        grossCents: true,
        vatCents: true,
        category: true,
        closedReason: true,
        payments: { select: { amountCents: true } },
      },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      take: SCAN_LIMIT + 1,
    });
    const matches = rows
      .slice(0, SCAN_LIMIT)
      .filter((row) => !args.supplier || fuzzyMatch(args.supplier, row.supplierName))
      .map((row) => ({
        row,
        position: openPosition({ status: row.status, grossCents: row.grossCents, paidCents: sumCents(row.payments), closedReason: row.closedReason }),
      }))
      .filter((entry) => (status === "open" || status === "overdue" ? entry.position.collectible : true));
    const page = pageOf(matches, args.cursor, args.limit);
    return {
      ok: true,
      period: periodOut(period),
      status,
      total: {
        count: matches.length,
        gross: eur(matches.reduce((sum, entry) => sum + entry.row.grossCents, 0)),
        vat: eur(matches.reduce((sum, entry) => sum + entry.row.vatCents, 0)),
        open: eur(matches.reduce((sum, entry) => sum + (entry.position.collectible ? entry.position.openCents : 0), 0)),
        ...(rows.length > SCAN_LIMIT ? { scanLimitReached: true } : {}),
      },
      items: page.items.map(({ row, position }) => ({
        id: row.id,
        supplier: row.supplierName,
        invoiceNumber: row.invoiceNumber,
        issueDate: isoDay(row.issueDate),
        dueDate: isoDay(row.dueDate),
        status: row.status === "open" && row.dueDate < overdueBefore(ctx.now) && position.collectible ? "overdue" : row.status,
        gross: eur(row.grossCents),
        vat: eur(row.vatCents),
        open: eur(position.collectible ? position.openCents : 0),
        category: row.category,
        href: `/kirjanpito/ostolaskut?id=${encodeURIComponent(row.id)}`,
      })),
      nextCursor: page.nextCursor,
    };
  },
};

/* ------------------------------ period_summary ------------------------------ */

const summaryArgs = z.object({ ...periodArgs, compare: z.number().int().min(0).max(3).optional() }).strict();

function categoryRows(rows: CategoryRow[]) {
  return rows.slice(0, 12).map((row) => ({
    category: row.category,
    label: isKnownCategory(row.category) ? categoryLabel(row.category) : row.category,
    gross: eur(row.grossCents),
    net: eur(row.netCents),
    vat: eur(row.vatCents),
    count: row.count,
  }));
}

async function summarize(userId: string, period: ResolvedPeriod, detailed: boolean) {
  const sources = await loadAlvPeriodSources(userId, period.start, period.end);
  const report = buildProfitLoss(sources.reportReceipts, sources.reportInvoices);
  const total = report.total;
  const vat = alvReportOf(sources).field308;
  const headline = {
    period: periodOut(period),
    income: { gross: eur(total.incomeGrossCents), vat: eur(total.incomeVatCents), net: eur(total.incomeNetCents) },
    expenses: { gross: eur(total.expenseGrossCents), vat: eur(total.expenseVatCents), net: eur(total.expenseNetCents) },
    profitNet: eur(total.profitNetCents),
    profitGross: eur(total.profitGrossCents),
    vatPayable: { amount: eurOf(vat.amount), isRefund: vat.isRefund },
  };
  if (!detailed) return headline;
  return {
    ...headline,
    incomeByCategory: categoryRows(total.incomeByCategory),
    expenseByCategory: categoryRows(total.expenseByCategory),
    ...(period.months > 1
      ? {
          months: report.months.map((month) => ({
            month: month.month,
            incomeNet: eur(month.incomeNetCents),
            expenseNet: eur(month.expenseNetCents),
            profitNet: eur(month.profitNetCents),
          })),
        }
      : {}),
    counts: {
      receipts: total.receiptCount,
      invoices: total.invoiceCount,
      creditNotes: total.creditNoteCount,
      receiptsWithoutVat: total.missingVatCount,
      uncategorised: total.uncategorisedCount,
      undatedReceipts: report.undatedCount,
      excludedReceipts: sources.excludedReceiptCount,
      suspectedDuplicates: sources.suspectedDuplicateCount,
    },
  };
}

const periodSummary: ChatTool = {
  definition: {
    type: "function",
    function: {
      name: "period_summary",
      description:
        "Profit and loss of a period, as on Raportit: income, expenses and result (gross, VAT and net), VAT payable, by category and by month, optionally compared with the same-length periods right before it. Basis: invoice date (laskutusperuste). For 'last three months' pass from/to.",
      parameters: {
        type: "object",
        properties: {
          ...periodProps,
          compare: { type: "integer", description: "How many earlier periods of the same length to compare with (0-3)." },
        },
      },
    },
  },
  async run(ctx, raw) {
    const args = parseArgs(summaryArgs, raw);
    const period = resolvePeriod(args, ctx.now, true)!;
    const current = await summarize(ctx.userId, period, true);
    const previous = [];
    for (const earlier of previousPeriods(period, args.compare ?? 0)) previous.push(await summarize(ctx.userId, earlier, false));
    return { ok: true, basis: "laskutusperuste", ...current, ...(previous.length ? { previous } : {}), href: "/raportit" };
  },
};

/* ------------------------------- bank_position ------------------------------- */

const bankArgs = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).strict();

function ibanTail(iban: string | null): string | null {
  return iban ? `…${iban.slice(-4)}` : null;
}

const bankPosition: ChatTool = {
  definition: {
    type: "function",
    function: {
      name: "bank_position",
      description:
        "Bank balances per account and in total (EUR), as on Pankki. Without 'month' the latest balance; with 'month' (YYYY-MM) the closing balance of that month for bookkeeping accounts.",
      parameters: { type: "object", properties: { month: { type: "string", description: "YYYY-MM" } } },
    },
  },
  async run(ctx, raw) {
    const args = parseArgs(bankArgs, raw);
    const { overview, position } = await getBankPosition(ctx.userId, { now: ctx.now });
    const ledger = overview.accounts
      .filter((account) => !account.archivedAt)
      .map((account) => {
        const closing = args.month ? account.monthlyClosings.find((row) => row.month === args.month) : null;
        const balance = args.month ? (closing ? closing.balance : null) : account.currentBalance;
        return {
          name: account.name,
          bank: account.bankName,
          iban: ibanTail(account.iban),
          currency: account.currency,
          balance: balance == null ? null : eurOf(balance),
          asOf: args.month ?? "latest",
          lastReconciledMonth: account.lastReconciledMonth,
          reconciliationMismatches: account.mismatchCount,
          source: "kirjanpito",
        };
      });
    const connected = position.connectedOnly.map((account) => ({
      name: account.label ?? account.aspspName,
      bank: account.aspspName,
      iban: ibanTail(account.iban),
      currency: account.currency,
      // A bank-reported balance has no history: it answers only "now".
      balance: args.month || account.balance == null ? null : eurOf(account.balance),
      asOf: args.month ? null : account.balanceAt,
      source: "pankkiyhteys",
    }));
    const eurCents = [...ledger, ...connected]
      .filter((account) => account.currency === "EUR" && account.balance != null)
      .reduce((sum, account) => sum + Math.round(Number(account.balance) * 100), 0);
    return {
      ok: true,
      state: position.state,
      asOf: args.month ?? "latest",
      total: args.month ? eur(eurCents) : eurOf(position.totalBalance),
      hasBalance: args.month ? ledger.some((account) => account.balance != null) : position.hasBalance,
      excludedCurrencies: position.excludedCurrencies,
      accounts: [...ledger, ...connected],
      reconnectBank: position.reconnectBank,
      href: "/pankki",
    };
  },
};

/* ------------------------------- cash_forecast ------------------------------- */

const forecastArgs = z.object({ days: z.number().int().min(1).max(120).optional() }).strict();

const cashForecast: ChatTool = {
  definition: {
    type: "function",
    function: {
      name: "cash_forecast",
      description:
        "Cash outlook for the next N days (default 30): current bank balance, open sales invoices due by then (receivables, overdue included) and open purchase invoices due by then (payables), and the projected balance if all of them are paid on time.",
      parameters: { type: "object", properties: { days: { type: "integer", description: "1-120, default 30." } } },
    },
  },
  async run(ctx, raw) {
    const args = parseArgs(forecastArgs, raw);
    const days = args.days ?? 30;
    const today = isoDateToUtc(helsinkiCalendarDate(ctx.now));
    const horizon = new Date(today.getTime() + days * 86_400_000);
    const [{ position }, sales, purchases] = await Promise.all([
      getBankPosition(ctx.userId, { now: ctx.now }),
      prisma.salesInvoice.findMany({
        where: { userId: ctx.userId, status: "sent", documentKind: "invoice", currency: "EUR", dueDate: { lte: horizon } },
        select: { id: true, number: true, dueDate: true, grossCents: true, status: true, closedReason: true, customer: { select: { name: true } }, payments: { select: { amountCents: true } } },
        orderBy: { dueDate: "asc" },
      }),
      prisma.purchaseInvoice.findMany({
        where: { userId: ctx.userId, status: "open", dueDate: { lte: horizon } },
        select: { id: true, supplierName: true, dueDate: true, grossCents: true, status: true, closedReason: true, payments: { select: { amountCents: true } } },
        orderBy: { dueDate: "asc" },
      }),
    ]);
    const open = <T extends { grossCents: number; status: string; closedReason: string | null; payments: Array<{ amountCents: number }> }>(rows: T[]) =>
      rows
        .map((row) => ({ row, cents: openPosition({ status: row.status, grossCents: row.grossCents, paidCents: sumCents(row.payments), closedReason: row.closedReason }) }))
        .filter((entry) => entry.cents.collectible && entry.cents.openCents > 0)
        .map((entry) => ({ row: entry.row, openCents: entry.cents.openCents }));
    const receivables = open(sales);
    const payables = open(purchases);
    const overdueBy = overdueBefore(ctx.now);
    const side = <T extends { dueDate: Date }>(entries: Array<{ row: T; openCents: number }>, item: (row: T, openCents: number) => Record<string, unknown>) => ({
      total: eur(entries.reduce((sum, entry) => sum + entry.openCents, 0)),
      overdue: eur(entries.filter((entry) => entry.row.dueDate < overdueBy).reduce((sum, entry) => sum + entry.openCents, 0)),
      count: entries.length,
      items: entries.slice(0, 10).map((entry) => item(entry.row, entry.openCents)),
    });
    const balanceCents = Math.round(position.totalBalance * 100);
    const inCents = receivables.reduce((sum, entry) => sum + entry.openCents, 0);
    const outCents = payables.reduce((sum, entry) => sum + entry.openCents, 0);
    return {
      ok: true,
      today: isoDay(today),
      until: isoDay(horizon),
      days,
      bankBalance: position.hasBalance ? eur(balanceCents) : null,
      receivables: side(receivables, (row, cents) => ({ id: row.id, number: row.number, customer: row.customer.name, dueDate: isoDay(row.dueDate), open: eur(cents), href: detailHref("invoice", row.id) })),
      payables: side(payables, (row, cents) => ({ id: row.id, supplier: row.supplierName, dueDate: isoDay(row.dueDate), open: eur(cents), href: `/kirjanpito/ostolaskut?id=${encodeURIComponent(row.id)}` })),
      projectedBalance: position.hasBalance ? eur(balanceCents + inCents - outCents) : null,
      assumption: "Every open invoice is paid in full on its due date; overdue ones count as paid now. Recurring costs without an invoice are not included.",
    };
  },
};

/* --------------------------------- vat_return --------------------------------- */

const vatArgs = z.object({ period: z.string().max(10).optional() }).strict();

const vatReturn: ChatTool = {
  definition: {
    type: "function",
    function: {
      name: "vat_return",
      description:
        "The VAT return (ALV-ilmoitus) of one period exactly as the ALV-ilmoitus screen computes it: sales VAT per rate, deductible VAT, VAT payable or refundable, receipts awaiting review, and whether it is marked filed or paid. Period YYYY-MM, YYYY-Qn or YYYY; default the current month.",
      parameters: { type: "object", properties: { period: { type: "string" } } },
    },
  },
  async run(ctx, raw) {
    const args = parseArgs(vatArgs, raw);
    const key = args.period?.trim().toUpperCase() || helsinkiMonthKey(ctx.now);
    if (!alvPeriodSchema.safeParse(key).success) throw new ToolInputError("Invalid period: use YYYY-MM, YYYY-Qn or YYYY.");
    const { start, end } = alvPeriodBoundsUtc(key);
    const [user, sources, filing, pending] = await Promise.all([
      prisma.user.findUnique({ where: { id: ctx.userId }, select: { vatRegistered: true, vatPeriod: true } }),
      loadAlvPeriodSources(ctx.userId, start, end),
      getVatFiling(ctx.userId, key),
      countPendingReceipts(ctx.userId, start, end),
    ]);
    const report = alvReportOf(sources);
    const sales = (field: { netSales: number; vat: number }) => ({ netSales: eurOf(field.netSales), vat: eurOf(field.vat) });
    const figures = { amount: report.field308.amount, isRefund: report.field308.isRefund, filing };
    return {
      ok: true,
      period: key,
      vatRegistered: user?.vatRegistered ?? false,
      vatPeriodSetting: user?.vatPeriod ?? "month",
      sales255: sales(report.field301),
      sales135: sales(report.field302),
      sales10: sales(report.field303),
      zeroRatedTurnover: eurOf(report.field309.turnover),
      deductibleVat: eurOf(report.field307.amount),
      payable: { amount: eurOf(report.field308.amount), isRefund: report.field308.isRefund },
      needsReview: { count: report.review.count, salesGross: eurOf(report.review.salesGross), purchasesGross: eurOf(report.review.purchasesGross) },
      pendingReceiptCount: pending,
      filing: {
        state: vatFilingState(filing),
        filedAmount: filing?.filedAmount == null ? null : eurOf(filing.filedAmount),
        changedSinceFiling: vatChangedSinceFiling({ ...figures, pendingReceiptCount: pending }),
      },
      basis: "laskutusperuste",
      href: alvDrillHref(key),
    };
  },
};

/* --------------------------------- work_queue --------------------------------- */

const queueArgs = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), ...pageArgs }).strict();

function itemHref(item: DashboardItem): string | null {
  if ("receiptId" in item) return detailHref("receipt", item.receiptId);
  if ("invoiceId" in item) return detailHref("invoice", item.invoiceId);
  if ("transactionId" in item) return `/pankki/tapahtumat?nayta=toimet&rivi=${encodeURIComponent(item.transactionId)}`;
  return null;
}

function itemDate(item: DashboardItem): string | null {
  if ("dueDate" in item) return item.dueDate;
  if ("paidDate" in item) return item.paidDate;
  if ("issueDate" in item) return item.issueDate;
  if ("date" in item) return item.date;
  return null;
}

const workQueue: ChatTool = {
  definition: {
    type: "function",
    function: {
      name: "work_queue",
      description:
        "What is left to do in a month (as Koti and Kuukauden sulku show it): open tasks by kind (receipts to approve, bank rows without a receipt, matches to review, VAT gaps, draft and overdue invoices), and whether the month can be closed. Default the current month.",
      parameters: { type: "object", properties: { month: { type: "string", description: "YYYY-MM" }, ...pageProps } },
    },
  },
  async run(ctx, raw) {
    const args = parseArgs(queueArgs, raw);
    const current = helsinkiMonthKey(ctx.now);
    const month = args.month ?? current;
    const { start, end } = alvPeriodBoundsUtc(month);
    const [items, lockedThrough, user, statements, receiptCount, invoiceCount, purchaseCount] = await Promise.all([
      buildDashboardItems(ctx.userId, month, month === current, ctx.now, undefined, 200),
      getLockedThrough(ctx.userId),
      prisma.user.findUnique({ where: { id: ctx.userId }, select: { vatRegistered: true, vatPeriod: true } }),
      prisma.statement.count({ where: { userId: ctx.userId, periodMonth: month } }),
      prisma.receipt.count({ where: { userId: ctx.userId, date: { gte: start, lt: end } } }),
      prisma.salesInvoice.count({ where: { userId: ctx.userId, issueDate: { gte: start, lt: end } } }),
      prisma.purchaseInvoice.count({ where: { userId: ctx.userId, issueDate: { gte: start, lt: end } } }),
    ]);
    const vatPeriod = user?.vatRegistered ? vatPeriodEndingIn(month, vatPeriodKindOf(user.vatPeriod)) : null;
    let vat: MonthCloseFacts["vat"] = null;
    let vatKey: string | null = null;
    if (vatPeriod) {
      vatKey = vatPeriodKey(vatPeriod);
      const bounds = alvPeriodBoundsUtc(vatKey);
      const [filing, sources] = await Promise.all([getVatFiling(ctx.userId, vatKey), loadAlvPeriodSources(ctx.userId, bounds.start, bounds.end)]);
      const field = alvReportOf(sources).field308;
      const figures = { amount: field.amount, isRefund: field.isRefund, filing, pendingReceiptCount: 0 };
      const state = vatFilingState(filing);
      const changed = vatChangedSinceFiling(figures);
      const nothingToPay = vatNothingToPay(figures);
      vat = { state, changedSinceFiling: changed, nothingToPay, done: !changed && (state === "paid" || (state === "filed" && nothingToPay)) };
    }
    const shown = items.items.filter((item) => month === current || item.kind !== "overdue_invoice");
    const facts: MonthCloseFacts = {
      ended: month < current,
      locked: isMonthLocked(lockedThrough, month),
      blocking: items.blockingTotal,
      hasContent: statements + receiptCount + invoiceCount + purchaseCount + shown.length > 0,
      hasStatement: statements > 0,
      vat,
    };
    const page = pageOf(shown, args.cursor, args.limit);
    return {
      ok: true,
      month,
      verdict: monthCloseSubtitle(facts),
      ended: facts.ended,
      locked: facts.locked,
      blockingTotal: items.blockingTotal,
      countsByKind: items.totals,
      hasStatement: facts.hasStatement,
      vat: vat ? { period: vatKey, ...vat } : null,
      items: page.items.map((item) => ({
        kind: item.kind,
        party: item.party,
        amount: item.amount == null ? null : eurOf(item.amount),
        date: itemDate(item),
        href: itemHref(item),
      })),
      nextCursor: page.nextCursor,
      href: `/kirjanpito/kuukausi?month=${month}`,
    };
  },
};

export const READ_TOOLS: ChatTool[] = [
  searchInvoices,
  searchReceipts,
  searchPurchaseInvoices,
  periodSummary,
  bankPosition,
  cashForecast,
  vatReturn,
  workQueue,
];
