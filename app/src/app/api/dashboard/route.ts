import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { VAT_REGISTRATION_THRESHOLD_EUR } from "@/lib/vero/omavero-fields";
import { centsToEuros } from "@/lib/money";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthParam = new URL(req.url).searchParams.get("month");
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam || "")
    ? monthParam!
    : currentMonth;

  const [year, monthNum] = month.split("-").map(Number);
  const startOfMonth = new Date(Date.UTC(year, monthNum - 1, 1));
  const endOfMonth = new Date(Date.UTC(year, monthNum, 1));

  // Cash view follows the tiliote's assigned kohdekuukausi (periodMonth),
  // not each bank row's booking date — so reassigning a statement moves it.
  const transactions = await prisma.transaction.findMany({
    where: {
      statement: { userId: session.userId, periodMonth: month },
    },
    select: {
      amountCents: true,
      type: true,
      matchStatus: true,
    },
  });

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
  const receipts = await prisma.receipt.findMany({
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

  let receiptIncome = 0;
  let receiptExpenses = 0;
  let salesVat = 0;
  let deductibleVat = 0;

  for (const r of receipts) {
    if (r.totalAmountCents == null) continue;
    let details: { rate: number; amount: number }[] = [];
    if (r.vatDetails) {
      try {
        details = JSON.parse(r.vatDetails);
      } catch {
        details = [];
      }
    }
    const vatSum = details.reduce((a, d) => a + (Number(d.amount) || 0), 0);
    const totalAmount = centsToEuros(r.totalAmountCents);

    if (r.type === "tulo") {
      receiptIncome += totalAmount;
      salesVat += vatSum;
    } else if (r.type === "meno") {
      receiptExpenses += totalAmount;
      deductibleVat += vatSum;
    }
  }

  const estimatedVat = salesVat - deductibleVat;
  const hasBankData = transactions.length > 0;

  // Calendar-year liikevaihto vs the 20 000 € ALV registration threshold
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const endOfYear = new Date(Date.UTC(year + 1, 0, 1));
  const yearPrefix = `${year}-`;
  const [yearTx, yearReceipts, user] = await Promise.all([
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
    prisma.user.findUnique({
      where: { id: session.userId },
      select: { entityType: true, vatRegistered: true, imapAccount: { select: { id: true } } },
    }),
  ]);
  const bankYtd = yearTx.reduce((a, t) => a + centsToEuros(t.amountCents), 0);
  const receiptYtd = yearReceipts.reduce((a, r) => a + centsToEuros(r.totalAmountCents || 0), 0);
  const ytdRevenue = yearTx.length > 0 ? bankYtd : receiptYtd;

  const pendingReceiptsCount = await prisma.receipt.count({
    where: { userId: session.userId, reviewStatus: "pending" },
  });

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
    hasImap: !!user?.imapAccount,
    pendingReceiptsCount,
  });
}
