import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { VAT_REGISTRATION_THRESHOLD_EUR } from "@/lib/vero/omavero-fields";
import { centsToEuros } from "@/lib/money";
import { parseBusinessDetails, deriveVatProfile } from "@/lib/onboarding";
import { getBankOverview } from "@/lib/bank-accounts";
import { buildAging, buildAgingReport, openPosition, type InvoiceStatus } from "@/lib/invoices";
import { computeAlvReport } from "@/lib/alv";
import { loadAlvPeriodSources, type AlvPeriodSources } from "@/lib/alv-period";
import { buildProfitLoss } from "@/lib/reports";
import { helsinkiMonthKey } from "@/lib/validation";

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
  let transactions: Array<{ amountCents: number; type: string; matchStatus: string }> = [];
  try {
    transactions = await prisma.transaction.findMany({
      where: {
        statement: { userId: session.userId, periodMonth: month },
      },
      select: {
        amountCents: true,
        type: true,
        matchStatus: true,
      },
    });
  } catch {
    sectionErrors.matching = "Kuittien linkitystä ei saatu ladattua.";
  }

  let bankIncome = 0;
  let bankExpenses = 0;
  let matchable = 0;
  let matched = 0;
  let suggested = 0;
  for (const t of transactions) {
    const amount = centsToEuros(t.amountCents);
    if (t.type === "tulo") bankIncome += amount;
    else if (t.type === "meno") bankExpenses += Math.abs(amount);
    // oma_siirto excluded on purpose
    if (t.type === "tulo" || t.type === "meno") {
      if (t.matchStatus !== "ignored") matchable += 1;
      if (t.matchStatus === "confirmed") matched += 1;
      if (t.matchStatus === "suggested") suggested += 1;
    }
  }

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
    const alvReport = computeAlvReport(books.receipts, books.invoices);
    estimatedVat = alvReport.field308.isRefund
      ? -alvReport.field308.amount
      : alvReport.field308.amount;
  }
  const hasBankData = transactions.length > 0;

  // Calendar-year liikevaihto vs the 20 000 € ALV registration threshold.
  // Same rule as the month: bank rows when the year has any, else documents
  // (receipts plus sales invoices). Never both, so nothing counts twice.
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const endOfYear = new Date(Date.UTC(year + 1, 0, 1));
  const yearPrefix = `${year}-`;
  let ytdRevenue = 0;
  try {
    const yearTx = await prisma.transaction.findMany({
      where: {
        type: "tulo",
        statement: {
          userId: session.userId,
          periodMonth: { startsWith: yearPrefix },
        },
      },
      select: { amountCents: true },
    });
    if (yearTx.length > 0) {
      ytdRevenue = yearTx.reduce((a, t) => a + centsToEuros(t.amountCents), 0);
    } else {
      const yearBooks = await loadAlvPeriodSources(session.userId, startOfYear, endOfYear);
      ytdRevenue = centsToEuros(
        buildProfitLoss(yearBooks.reportReceipts, yearBooks.reportInvoices).total.incomeGrossCents
      );
    }
  } catch {
    sectionErrors.threshold = "ALV-rajaa ei saatu ladattua.";
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      entityType: true,
      vatRegistered: true,
      businessDetails: true,
      imapAccounts: { select: { id: true }, take: 1 },
    },
  });

  const businessProfile = parseBusinessDetails(user?.businessDetails);
  const vatProfile = deriveVatProfile(businessProfile);

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
  let bankOverview: Awaited<ReturnType<typeof getBankOverview>> | null = null;
  let receivables = { totalOpen: 0, overdue: 0, overdueCount: 0 };
  let payables = { totalOpen: 0, overdue: 0, overdueCount: 0 };
  try {
    bankOverview = await getBankOverview(session.userId);
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
    bank: bankOverview
      ? {
          totalBalance: bankOverview.totalBalance,
          accountCount: bankOverview.accounts.length,
          needsAttention: bankOverview.needsAttention,
        }
      : null,
    receivables,
    payables,
    isSingleVatProfile: vatProfile.isSingleRate && vatProfile.isVatRegistered,
    singleVatRate: vatProfile.defaultSalesRate,
    ...(Object.keys(sectionErrors).length > 0 ? { sectionErrors } : {}),
  });
}
