import { beforeEach, describe, expect, it } from "vitest";
import { GET as listReceipts } from "@/app/api/receipts/route";
import { GET as listInvoices } from "@/app/api/invoices/route";
import { prisma } from "@/lib/db";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

const ROWS = 2500;
const PAGE = 200;
/** CI ceiling. The design target for an unscored receipt page is 1.5s. See app/docs/perf-budgets.md. */
const BUDGET_MS = 8_000;

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

describe("large lists stay paged", () => {
  it(
    "pages thousands of receipts, invoices, and transactions inside the budget",
    async () => {
      const customer = await prisma.customer.create({
        data: { userId: user.id, name: "Iso Asiakas Oy" },
      });
      const statement = await prisma.statement.create({
        data: {
          userId: user.id,
          fileName: "iso.csv",
          fileType: "csv",
          filePath: "/tmp/iso.csv",
          checksum: "iso-checksum",
          periodMonth: "2026-01",
        },
      });

      const receiptRows = Array.from({ length: ROWS }, (_, index) => ({
        userId: user.id,
        type: "meno",
        date: new Date(Date.UTC(2020, 0, 1) + index * 86_400_000),
        totalAmountCents: 1000 + index,
        vendor: `Myyjä ${index}`,
        reviewStatus: "approved",
        filePath: `/tmp/kuitti-${index}.pdf`,
        fileName: "kuitti.pdf",
      }));
      for (const batch of chunks(receiptRows, 400)) {
        await prisma.receipt.createMany({ data: batch });
      }

      const txRows = Array.from({ length: ROWS }, (_, index) => ({
        statementId: statement.id,
        userId: user.id,
        bankRef: `ref-${index}`,
        date: new Date(Date.UTC(2026, 0, 1)),
        counterparty: `Pankki ${index}`,
        amountCents: -1000 - index,
        type: "meno",
        matchStatus: "unmatched",
      }));
      for (const batch of chunks(txRows, 400)) {
        await prisma.transaction.createMany({ data: batch });
      }

      const invoiceRows = Array.from({ length: ROWS }, (_, index) => ({
        userId: user.id,
        customerId: customer.id,
        number: index + 1,
        reference: `8${String(index).padStart(8, "0")}`,
        issueDate: new Date(Date.UTC(2024, 0, 1)),
        dueDate: new Date(Date.UTC(2024, 0, 15)),
        status: "draft",
        grossCents: 1500,
      }));
      for (const batch of chunks(invoiceRows, 400)) {
        await prisma.salesInvoice.createMany({ data: batch });
      }

      const receiptStarted = Date.now();
      const receiptResponse = await listReceipts(
        buildRequest("GET", "/api/receipts", undefined, { cookie })
      );
      const receiptMs = Date.now() - receiptStarted;
      expect(receiptResponse.status).toBe(200);
      const receiptBody = await readJson(receiptResponse);
      expect(receiptBody.count).toBe(ROWS);
      expect(receiptBody.receipts).toHaveLength(PAGE);
      expect(receiptBody.truncated).toBe(true);
      expect(receiptBody.receipts.every((row: { match: { matchCandidates: unknown[] } }) => row.match.matchCandidates.length === 0)).toBe(true);
      expect(receiptMs).toBeLessThan(BUDGET_MS);

      const invoiceStarted = Date.now();
      const invoiceResponse = await listInvoices(
        buildRequest("GET", "/api/invoices?status=all", undefined, { cookie })
      );
      const invoiceMs = Date.now() - invoiceStarted;
      expect(invoiceResponse.status).toBe(200);
      const invoiceBody = await readJson(invoiceResponse);
      expect(invoiceBody.invoices).toHaveLength(PAGE);
      expect(invoiceMs).toBeLessThan(BUDGET_MS);

      const txStarted = Date.now();
      const [txCount, txPage] = await Promise.all([
        prisma.transaction.count({ where: { statementId: statement.id } }),
        prisma.transaction.findMany({
          where: { statementId: statement.id },
          orderBy: { bankRef: "asc" },
          take: PAGE,
        }),
      ]);
      const txMs = Date.now() - txStarted;
      expect(txCount).toBe(ROWS);
      expect(txPage).toHaveLength(PAGE);
      expect(txMs).toBeLessThan(BUDGET_MS);
    },
    120_000
  );
});
