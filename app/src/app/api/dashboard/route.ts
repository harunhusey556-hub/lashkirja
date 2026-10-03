import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { VAT_REGISTRATION_THRESHOLD_EUR } from "@/lib/vero/omavero-fields";
import { centsToEuros } from "@/lib/money";
import { parseBusinessDetails, deriveVatProfile } from "@/lib/onboarding";
import { bankEverConnected, getBankPosition, loadBalanceTrend, type BalancePoint, type BankPosition, type PositionConnection } from "@/lib/bank-position";
import { loadCashflow, type CashflowMonth } from "@/lib/koti-cashflow";
import { buildAging, buildAgingReport, openPosition, type InvoiceStatus } from "@/lib/invoices";
import { alvReportOf, loadAlvPeriodSources, type AlvPeriodSources } from "@/lib/alv-period";
import { computeYearTurnover } from "@/lib/alv-threshold";
import { buildProfitLoss } from "@/lib/reports";
import { helsinkiMonthKey } from "@/lib/validation";
import { buildDashboardItems, loadSharedMatchData, type DashboardItems } from "./items";
import { MONTH_ROW_FACTS, monthProgress } from "@/lib/month-rows";
import { getLockedThrough, isMonthLocked } from "@/lib/period-lock";
import { summariseHandled, type Handled } from "@/lib/koti-handled";
import { monthEvents } from "@/lib/koti-month";

/** Koti's "Hoidettu automaattisesti" looks back this far. */
const HANDLED_DAYS = 7;

function previousMonthKey(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const now = new Date();
  const currentMonth = helsinkiMonthKey(now);
  const monthParam = new URL(req.url).searchParams.get("month");
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam || "")
    ? monthParam!
    : currentMonth;

  const [year, monthNum] = month.split("-").map(Number);
  const startOfMonth = new Date(Date.UTC(year, monthNum - 1, 1));
  const endOfMonth = new Date(Date.UTC(year, monthNum, 1));
  const sectionErrors: Record<string, string> = {};

  // Cash view follows the tiliote's assigned kohdekuukausi (periodMonth),
  // not each bank row's booking date — so reassigning a statement moves it.
  // A failure here must not blank the receipt-based income below.
  let transactions: Array<{
    amountCents: number;
    type: string;
    matchStatus: string;
    receiptId: string | null;
    invoicePayment: { id: string } | null;
    purchasePayment: { id: string } | null;
  }> = [];
  try {
    transactions = await prisma.transaction.findMany({
      where: {
        statement: { userId: session.userId, periodMonth: month },
      },
      select: {
        amountCents: true,
        ...MONTH_ROW_FACTS,
      },
    });
  } catch {
    sectionErrors.matching = "Kuittien kohdistusta ei saatu ladattua.";
  }

  let bankIncome = 0;
  let bankExpenses = 0;
  for (const t of transactions) {
    const amount = centsToEuros(t.amountCents);
    if (t.type === "tulo") bankIncome += amount;
    else if (t.type === "meno") bankExpenses += Math.abs(amount);
    // oma_siirto excluded on purpose
  }
  // FP-2: the bar and the task rows use one rule for "in order" (lib/month-rows.ts):
  // a row that settled an invoice is done, and every row that is not has a task.
  const { matchable, matched, suggested } = monthProgress(transactions);

  // The document view (no tiliote for the month yet) is the profit and loss
  // of the month: approved receipts plus sales invoices by invoice date, with
  // credit notes negative and bank-settled income receipts left out. The VAT
  // estimate is computed from exactly the same sources as the VAT return, so
  // the front page, /raportit and /kirjanpito/alv cannot drift apart again.
  let books: AlvPeriodSources | null = null;
  try {
    books = await loadAlvPeriodSources(session.userId, startOfMonth, endOfMonth);
  } catch (error) {
    if (transactions.length === 0) throw error;
    sectionErrors.receipts = "Kuittimäärää ei saatu ladattua.";
    sectionErrors.vat = "ALV-arviota ei saatu ladattua.";
  }

  const monthBooks = books
    ? buildProfitLoss(books.reportReceipts, books.reportInvoices).total
    : null;
  const documentIncome = monthBooks ? centsToEuros(monthBooks.incomeGrossCents) : 0;
  const documentExpenses = monthBooks ? centsToEuros(monthBooks.expenseGrossCents) : 0;

  let estimatedVat = 0;
  if (books) {
    const alvReport = alvReportOf(books);
    estimatedVat = alvReport.field308.isRefund
      ? -alvReport.field308.amount
      : alvReport.field308.amount;
  }
  const hasBankData = transactions.length > 0;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      entityType: true,
      vatRegistered: true,
      businessDetails: true,
      businessName: true,
      businessId: true,
      invoiceIban: true,
      createdAt: true,
      imapAccounts: { select: { id: true }, take: 1 },
    },
  });

  const businessProfile = parseBusinessDetails(user?.businessDetails);
  const vatProfile = deriveVatProfile(businessProfile);

  // Calendar-year liikevaihto vs the 20 000 € VAT threshold (AVL 3 §), without
  // VAT. The basis is chosen per month: bank rows for a month with a tiliote,
  // documents for the rest, so a single statement cannot hide the invoices of
  // the other months and nothing counts twice.
  let ytdRevenue = 0;
  try {
    const turnover = await computeYearTurnover(session.userId, year, vatProfile.defaultSalesRate);
    ytdRevenue = centsToEuros(turnover.netCents);
  } catch {
    sectionErrors.threshold = "ALV-rajaa ei saatu ladattua.";
  }

  let pendingReceiptsCount = 0;
  try {
    pendingReceiptsCount = await prisma.receipt.count({
      where: { userId: session.userId, reviewStatus: "pending" },
    });
  } catch {
    sectionErrors.pending = "Tarkastettavia kuitteja ei saatu ladattua.";
  }

  // Bank position and receivables: the two numbers a business owner checks
  // first, and neither was visible on the front page before.
  // OWN-18: ledger accounts AND the accounts of an Enable Banking consent (lib/bank-position.ts).
  let bankPosition: BankPosition | null = null;
  let bankConnections: PositionConnection[] | null = null;
  let bankTrend: BalancePoint[] | null = null;
  let receivables = { totalOpen: 0, overdue: 0, overdueCount: 0 };
  let payables = { totalOpen: 0, overdue: 0, overdueCount: 0 };
  try {
    const bank = await getBankPosition(session.userId, { now });
    bankPosition = bank.position;
    bankConnections = bank.connections;
    try {
      // The balance line on Koti: today's accounts, the last six months (OWN-22).
      bankTrend = await loadBalanceTrend(session.userId, bank.overview, bank.position, helsinkiMonthKey(now));
    } catch {
      bankTrend = null;
    }
    const openInvoices = await prisma.salesInvoice.findMany({
      where: { userId: session.userId, status: { in: ["sent", "paid"] } },
      select: {
        status: true,
        dueDate: true,
        grossCents: true,
        closedReason: true,
        payments: { select: { amountCents: true } },
      },
    });
    const openPayables = await prisma.purchaseInvoice.findMany({
      where: { userId: session.userId, status: { in: ["open", "paid"] } },
      select: {
        status: true,
        dueDate: true,
        grossCents: true,
        closedReason: true,
        payments: { select: { amountCents: true } },
      },
    });
    const payablesAging = buildAging(
      openPayables.map((invoice) => {
        const paidCents = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
        const position = openPosition({
          status: invoice.status,
          grossCents: invoice.grossCents,
          paidCents,
          closedReason: invoice.closedReason,
        });
        return {
          dueDate: invoice.dueDate,
          openCents: position.collectible ? position.openCents : 0,
        };
      }),
      now
    );
    const aging = buildAgingReport(
      openInvoices.map((invoice) => ({
        status: invoice.status as InvoiceStatus,
        dueDate: invoice.dueDate,
        grossCents: invoice.grossCents,
        paidCents: invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0),
        closedReason: invoice.closedReason,
      })),
      now
    );
    receivables = {
      totalOpen: centsToEuros(aging.totalOpenCents),
      overdue: centsToEuros(aging.overdueCents),
      overdueCount: aging.overdueCount,
    };
    payables = {
      totalOpen: centsToEuros(payablesAging.totalOpenCents),
      overdue: centsToEuros(payablesAging.overdueCents),
      overdueCount: payablesAging.overdueCount,
    };
  } catch {
    sectionErrors.position = "Saamisia ja velkoja ei saatu ladattua.";
  }

  // "Tarvitaan sinulta": concrete items with the other party and the data
  // each one-tap action needs, scoped to the month (see items.ts).
  let koti: DashboardItems | null = null;
  // FP-3: until last month is closed, the current month names what is left in it.
  let previousMonth: { month: string; open: number } | null = null;
  try {
    const shared = await loadSharedMatchData(session.userId, now);
    koti = await buildDashboardItems(session.userId, month, month >= currentMonth, now, shared);
    if (month >= currentMonth) {
      const prev = previousMonthKey(currentMonth);
      const lockedThrough = await getLockedThrough(session.userId);
      if (!isMonthLocked(lockedThrough, prev)) {
        const prevItems = await buildDashboardItems(session.userId, prev, false, now, shared);
        const prevBounds = { gte: new Date(`${prev}-01T00:00:00.000Z`), lt: new Date(`${currentMonth}-01T00:00:00.000Z`) };
        const [prevReceipts, prevStatements, prevInvoices] = await Promise.all([
          prisma.receipt.count({ where: { userId: session.userId, date: prevBounds } }),
          prisma.statement.count({ where: { userId: session.userId, periodMonth: prev } }),
          prisma.salesInvoice.count({ where: { userId: session.userId, issueDate: prevBounds } }),
        ]);
        // A month with nothing in it has nothing to close.
        if (prevItems.blockingTotal > 0 || prevReceipts + prevStatements + prevInvoices > 0) {
          previousMonth = { month: prev, open: prevItems.blockingTotal };
        }
      }
    }
  } catch {
    sectionErrors.items = "Tehtäviä ei saatu ladattua.";
  }

  // TF-06: a brand-new account gets a start checklist instead of "Kaikki kunnossa".
  let setup: { receipts: boolean; bank: boolean; seller: boolean; empty: boolean } | null = null;
  try {
    const [anyReceipt, anyStatement, anyAccount, anyInvoice] = await Promise.all([
      prisma.receipt.count({ where: { userId: session.userId }, take: 1 }),
      prisma.statement.count({ where: { userId: session.userId }, take: 1 }),
      prisma.bankAccount.count({ where: { userId: session.userId }, take: 1 }),
      prisma.salesInvoice.count({ where: { userId: session.userId }, take: 1 }),
    ]);
    const seller = Boolean(user?.businessName && user?.businessId && user?.invoiceIban);
    setup = {
      receipts: anyReceipt > 0,
      // OWN-18: a bank connected through Enable Banking is a connected bank.
      bank: anyStatement + anyAccount > 0 || bankEverConnected(bankConnections ?? [], now),
      seller,
      empty: anyReceipt + anyStatement + anyInvoice === 0,
    };
  } catch {
    setup = null;
  }

  // OWN-22: income and expenses of the last six months (ending this month, so
  // the chart stays put while the owner steps through the months it shows).
  let cashflow: CashflowMonth[] | null = null;
  try {
    cashflow = await loadCashflow(session.userId, currentMonth);
  } catch {
    cashflow = null;
  }

  // The month's events for the bar: bank rows plus receipts no bank row accounts for.
  let events = { done: matched, total: matchable };
  try {
    const receiptWhere = {
      userId: session.userId,
      date: { gte: startOfMonth, lt: endOfMonth },
      linkedTransaction: null,
      sourceTransactionId: null,
    };
    const [approved, pending] = await Promise.all([
      prisma.receipt.count({ where: { ...receiptWhere, reviewStatus: "approved" } }),
      prisma.receipt.count({ where: { ...receiptWhere, reviewStatus: "pending" } }),
    ]);
    events = monthEvents({ matchable, matched }, { approved, pending });
  } catch {
    // The bar then counts the bank rows alone, which is still true.
  }

  // What the app did for the owner in the last 7 days: real records only (see lib/koti-handled.ts).
  let handled: Handled | null = null;
  if (month >= currentMonth) {
    try {
      const since = new Date(now.getTime() - HANDLED_DAYS * 24 * 60 * 60 * 1000);
      const [emailReceipts, salesPayments, purchasePayments, recurringInvoices] = await Promise.all([
        prisma.receipt.count({ where: { userId: session.userId, source: "email_sync", createdAt: { gte: since } } }),
        prisma.invoicePayment.count({
          where: { invoice: { userId: session.userId }, source: "bank", note: "Kohdistettu viitenumerolla", createdAt: { gte: since } },
        }),
        prisma.purchasePayment.count({
          where: { purchaseInvoice: { userId: session.userId }, source: "bank", note: "Kohdistettu viitenumerolla", createdAt: { gte: since } },
        }),
        prisma.recurringInvoiceRun.count({
          where: { recurringInvoice: { userId: session.userId }, status: "created", createdAt: { gte: since } },
        }),
      ]);
      handled = summariseHandled({
        emailReceipts,
        referencePayments: salesPayments + purchasePayments,
        recurringInvoices,
      });
    } catch {
      handled = null;
    }
  }

  return NextResponse.json({
    firstName: session.firstName,
    month,
    // Bank data is the primary cash view (kassaperuste): an invoice paid into
    // the account is already one of the bank rows, so invoices are never added
    // on top. Without a tiliote the month is shown from the documents
    // (laskutusperuste): receipts plus sales invoices.
    income: round2(hasBankData ? bankIncome : documentIncome),
    expenses: round2(hasBankData ? bankExpenses : documentExpenses),
    source: hasBankData ? "tiliote" : "kuitit",
    basis: hasBankData ? "kassaperuste" : "laskutusperuste",
    txCount: transactions.length,
    receiptCount: books?.receiptCount ?? 0,
    invoiceCount: monthBooks ? monthBooks.invoiceCount + monthBooks.creditNoteCount : 0,
    matching: { matchable, matched, suggested },
    events,
    handled: handled && handled.count > 0 ? handled : null,
    estimatedVat: round2(estimatedVat),
    isRefund: estimatedVat < 0,
    vat: {
      registered: user?.vatRegistered ?? false,
      entityType: user?.entityType ?? "toiminimi",
      ytdRevenue: round2(ytdRevenue),
      threshold: VAT_REGISTRATION_THRESHOLD_EUR,
    },
    hasImap: (user?.imapAccounts?.length ?? 0) > 0,
    pendingReceiptsCount,
    bank: bankPosition
      ? {
          totalBalance: bankPosition.totalBalance,
          accountCount: bankPosition.accountCount,
          needsAttention: bankPosition.needsAttention,
          state: bankPosition.state,
          hasBalance: bankPosition.hasBalance,
          reconnectBank: bankPosition.reconnectBank,
        }
      : null,
    bankTrend: bankTrend ? { points: bankTrend } : null,
    cashflow,
    receivables,
    payables,
    items: koti?.items ?? [],
    itemTotals: koti?.totals ?? null,
    blockingTotal: koti?.blockingTotal ?? null,
    previousMonth,
    setup,
    // The Helsinki month the account was opened: Koti does not ask for a VAT
    // return of a period that ended before the account existed.
    accountCreatedMonth: user?.createdAt ? helsinkiMonthKey(user.createdAt) : null,
    isSingleVatProfile: vatProfile.isSingleRate && vatProfile.isVatRegistered,
    singleVatRate: vatProfile.defaultSalesRate,
    ...(Object.keys(sectionErrors).length > 0 ? { sectionErrors } : {}),
  });
}
