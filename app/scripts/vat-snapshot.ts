/**
 * Prints the VAT return and the purchase total of a few months for one owner,
 * to compare a data fix before and after (read only).
 *   DATABASE_URL=... npx tsx scripts/vat-snapshot.ts <userId> 2026-02 2026-07 ...
 */
import { prisma } from "../src/lib/db";
import { alvReportOf, loadAlvPeriodSources } from "../src/lib/alv-period";
import { alvPeriodBoundsUtc } from "../src/lib/validation";
import { buildProfitLoss } from "../src/lib/reports";

async function main() {
  const [userId, ...periods] = process.argv.slice(2);
  for (const period of periods) {
    const { start, end } = alvPeriodBoundsUtc(period);
    const sources = await loadAlvPeriodSources(userId, start, end);
    const r = alvReportOf(sources);
    const pl = buildProfitLoss(sources.reportReceipts, sources.reportInvoices).total;
    console.log(
      `${period}  307=${r.field307.amount}  301vat=${r.field301.vat}  306=${r.field306.amount}  308=${r.field308.isRefund ? "-" : ""}${r.field308.amount}  ` +
        `notDeducted=${r.sources.foreignVatNotDeducted}  expensesGross=${pl.expenseGrossCents / 100}`
    );
  }
}
main().finally(() => prisma.$disconnect());
