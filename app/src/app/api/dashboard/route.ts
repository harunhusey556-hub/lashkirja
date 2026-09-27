import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { VAT_REGISTRATION_THRESHOLD_EUR } from "@/lib/vero/omavero-fields";
import { centsToEuros } from "@/lib/money";
import { parseBusinessDetails, deriveVatProfile } from "@/lib/onboarding";
import { getBankOverview } from "@/lib/bank-accounts";
import { buildAging, buildAgingReport, openPosition, type InvoiceStatus } from "@/lib/invoices";
import { computeAlvReport } from "@/lib/alv";
import { loadAlvPeriodSources } from "@/lib/alv-period";
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

  // Receipts remain the VAT source (bank rows carry no VAT info)
  let receipts: Array<{ totalAmountCents: number | null; vatDetails: unknown; type: string }> = [];
  try {
    receipts = await prisma.receipt.findMany({
      where: {
        userId: session.userId,
        date: { gte: startOfMonth, lt: endOfMonth },
        reviewStatus: "approved",
      },
      select: {
        totalAmountCents: true,
        vatDetails: true,
        type: true,
      },
    });
  } catch (error) {
    if (transactions.length === 0) throw error;
    sectionErrors.receipts = "Kuittimäärää ei saatu ladattua.";
  }

  let receiptIncome = 0;
  let receiptExpenses = 0;

  for (const r of receipts) {
    if (r.totalAmountCents == null) continue;
    const totalAmount = centsToEuros(r.totalAmountCents);
    if (r.type === "tulo") receiptIncome += totalAmount;
    else if (r.type === "meno") receiptExpenses += totalAmount;
  }

  // The estimate is computed from exactly the same sources as the VAT return,
  // including sales invoices and the double-counting exclusion. Computing it
  // separately here is how the front page and /kirjanpito/alv drifted apart.
  let estimatedVat = 0;
  try {
    const vatSources = await loadAlvPeriodSources(session.userId, startOfMonth, endOfMonth);
    const alvReport = computeAlvReport(vatSources.receipts, vatSources.invoices);
    estimatedVat = alvReport.field308.isRefund
      ? -alvReport.field308.amount
      : alvReport.field308.amount;
  } catch {
    sectionErrors.vat = "ALV-arviota ei saatu ladattua.";
  }
  const hasBankData = transactions.length > 0;

  // Calendar-year liikevaihto vs the 20 000 € ALV registration threshold
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const endOfYear = new Date(Date.UTC(year + 1, 0, 1));
  const yearPrefix = `${year}-`;
  let yearTx: Array<{ amountCents: number }> = [];
  let yearReceipts: Array<{ totalAmountCents: number | null }> = [];
  try {
    [yearTx, yearReceipts] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          type: "tulo",
          statement: {
            userId: session.userId,
            periodMonth: { startsWith: yearPrefix },
          },
        },
        select: { amountCents: true },
      }),
      prisma.receipt.findMany({
        where: {
          userId: session.userId,
          type: "tulo",
          date: { gte: startOfYear, lt: endOfYear },
          reviewStatus: "approved",
        },
        select: { totalAmountCents: true },
      }),
    ]);
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

  const bankYtd = yearTx.reduce((a, t) => a + centsToEuros(t.amountCents), 0);
  const receiptYtd = yearReceipts.reduce((a, r) => a + centsToEuros(r.totalAmountCents || 0), 0);
  const ytdRevenue = yearTx.length > 0 ? bankYtd : receiptYtd;

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
    // Bank data is the primary cash view; receipts only when no tiliote yet
    income: round2(hasBankData ? bankIncome : receiptIncome),
    expenses: round2(hasBankData ? bankExpenses : receiptExpenses),
    source: hasBankData ? "tiliote" : "kuitit",
    txCount: transactions.length,
    receiptCount: receipts.length,
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
