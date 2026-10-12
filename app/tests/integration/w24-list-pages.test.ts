import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import sharp from "sharp";
import { prisma } from "@/lib/db";
import { GET as listReceipts } from "@/app/api/receipts/route";
import { GET as listInvoicesRoute } from "@/app/api/invoices/route";
import { GET as invoiceCounts } from "@/app/api/invoices/counts/route";
import { GET as listPurchases } from "@/app/api/purchase-invoices/route";
import { GET as purchaseCounts } from "@/app/api/purchase-invoices/counts/route";
import { GET as bootstrap } from "@/app/api/bootstrap/route";
import { GET as syncVersion } from "@/app/api/sync/version/route";
import { GET as dashboard } from "@/app/api/dashboard/route";
import { GET as profitLoss } from "@/app/api/reports/profit-loss/route";
import { GET as preview } from "@/app/api/receipts/[id]/file/preview/route";
import { createCustomer } from "@/lib/customers";
import { createInvoice } from "@/lib/sales-invoices";
import { createPurchaseInvoice } from "@/lib/purchase-invoices";
import { DUPLICATE_DISMISSED_KIND } from "@/lib/alv-period";
import { readBooksStamp } from "@/lib/books-cache";
import { removeUserUpload, writePrivateUpload } from "@/lib/storage";
import { createBankAccountRow, createReceipt, createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

/**
 * W24: keyset pages of Kuitit / Myynti / Ostolaskut, ETag on the lists, the thumbnail widths,
 * GET /api/bootstrap, and the DataVersion-keyed Koti / report cache never serving a stale figure.
 */
let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

const req = (url: string, headers?: Record<string, string>) => buildRequest("GET", url, undefined, { cookie, headers });

type PageRow = { id: string; date: string | null; kind: string; matchStatus: string; thumbnailUrl: string | null; linkedTransaction: unknown };
type Page = { receipts: PageRow[]; nextCursor: string | null; total: number };

async function walkReceipts(query: string, limit: number) {
  const rows: PageRow[] = [];
  let cursor = "";
  let total = -1;
  for (let pages = 0; pages < 50; pages++) {
    const response = await listReceipts(req(`/api/receipts?${query}&cursor=${encodeURIComponent(cursor)}&limit=${limit}`));
    expect(response.status).toBe(200);
    const page = await readJson<Page>(response);
    total = page.total;
    rows.push(...page.receipts);
    if (!page.nextCursor) return { rows, total };
    cursor = page.nextCursor;
  }
  throw new Error("cursor never ended");
}

describe("GET /api/receipts?cursor= (Kuitit page)", () => {
  it("walks every receipt once, newest first by date then id, undated last", async () => {
    // Shared days force the id tie-break; two undated and some pending rows stay out of the default list.
    for (let i = 0; i < 61; i++) {
      await createReceipt(user.id, { date: `2026-0${(i % 3) + 7}-0${(i % 4) + 1}`, vendor: `Kauppa ${i}` });
    }
    await createReceipt(user.id, { date: null });
    await createReceipt(user.id, { date: null });
    for (let i = 0; i < 5; i++) await createReceipt(user.id, { reviewStatus: "pending" });

    const { rows, total } = await walkReceipts("kind=receipt", 20);
    expect(total).toBe(63);
    expect(rows).toHaveLength(63);
    expect(new Set(rows.map((r) => r.id)).size).toBe(63);
    const expected = await prisma.receipt.findMany({
      where: { userId: user.id, reviewStatus: "approved" },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    expect(rows.map((r) => r.id)).toEqual(expected.map((r) => r.id));
    expect(rows.slice(-2).every((r) => r.date === null)).toBe(true);

    const pending = await walkReceipts("reviewStatus=pending", 2);
    expect(pending.total).toBe(5);
    expect(pending.rows).toHaveLength(5);
  });

  it("gives a narrow row with kind, match status and no thumbnail for a row without a stored file", async () => {
    const account = await createBankAccountRow(user.id, { name: "Tili", iban: "FI2112345600000785", isDefault: true });
    const statement = await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      periodMonth: "2026-09",
      transactions: [{ date: "2026-09-03", amountCents: -12_550, counterparty: "Tukku Oy" }],
    });
    const linked = await createReceipt(user.id, { date: "2026-09-03" });
    const tx = await prisma.transaction.findFirstOrThrow({ where: { statementId: statement.id } });
    await prisma.transaction.update({ where: { id: tx.id }, data: { receiptId: linked.id, matchStatus: "matched" } });
    const plain = await createReceipt(user.id, { date: "2026-09-01" });

    const page = await readJson<Page & { receipts: Array<Record<string, unknown>> }>(
      await listReceipts(req("/api/receipts?cursor=&limit=50"))
    );
    const byId = new Map(page.receipts.map((r) => [r.id, r]));
    expect(byId.get(linked.id)).toMatchObject({ matchStatus: "linked", kind: "receipt", thumbnailUrl: null, totalAmount: 125.5, totalAmountCents: 12_550, currency: "EUR" });
    expect((byId.get(linked.id)!.linkedTransaction as { id: string }).id).toBe(tx.id);
    expect(byId.get(plain.id)).toMatchObject({ matchStatus: "unlinked", linkedTransaction: null });
    // Narrow: none of the extraction or the match candidates.
    for (const key of ["rawText", "vatDetails", "notes", "match", "filePath"]) expect(byId.get(plain.id)).not.toHaveProperty(key);
  });

  it("answers 304 to its own ETag and 400 to a bad cursor, limit or sort", async () => {
    await createReceipt(user.id);
    const first = await listReceipts(req("/api/receipts?cursor=&limit=10"));
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    expect((await listReceipts(req("/api/receipts?cursor=&limit=10", { "if-none-match": etag }))).status).toBe(304);
    expect((await listReceipts(req("/api/receipts?cursor=bm9wZQ&limit=10"))).status).toBe(400);
    expect((await listReceipts(req("/api/receipts?cursor=&limit=0"))).status).toBe(400);
    expect((await listReceipts(req("/api/receipts?cursor=&limit=201"))).status).toBe(400);
    expect((await listReceipts(req("/api/receipts?cursor=&sort=amount_desc"))).status).toBe(400);
  });

  it("keeps the legacy no-param shape, now with an ETag", async () => {
    await createReceipt(user.id);
    const response = await listReceipts(req("/api/receipts"));
    const body = await readJson<Record<string, unknown>>(response);
    expect(Object.keys(body).sort()).toEqual(["count", "receipts", "truncated"]);
    expect((body.receipts as Array<Record<string, unknown>>)[0]).toHaveProperty("match");
    expect((await listReceipts(req("/api/receipts", { "if-none-match": response.headers.get("etag")! }))).status).toBe(304);
  });
});

describe("Myynti and Ostolaskut pages", () => {
  it("walks sales invoices by issue date desc and purchases by due date asc, with totals", async () => {
    const customer = await createCustomer(user.id, { name: "Asiakas Oy" });
    for (let i = 0; i < 5; i++) {
      await createInvoice(user.id, { customerId: customer.id, issueDate: `2026-0${(i % 2) + 3}-10`, lines: [{ description: "Työ", quantity: 1, unitPrice: 10 + i, vatRate: 25.5 }] });
      await createPurchaseInvoice(user.id, { supplierName: `Toimittaja ${i}`, issueDate: "2026-02-01", dueDate: `2026-0${(i % 2) + 3}-01`, gross: 20 + i });
    }
    const walk = async (route: (r: ReturnType<typeof req>) => Promise<Response>, base: string) => {
      const ids: string[] = [];
      let cursor = "";
      for (let pages = 0; pages < 10; pages++) {
        const page = await readJson<{ invoices: Array<{ id: string }>; nextCursor: string | null; total: number; aging: unknown }>(
          await route(req(`${base}?cursor=${encodeURIComponent(cursor)}&limit=2`))
        );
        expect(page.total).toBe(5);
        expect(page.aging).toBeTruthy();
        ids.push(...page.invoices.map((i) => i.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return ids;
    };
    const sales = await prisma.salesInvoice.findMany({ where: { userId: user.id }, orderBy: [{ issueDate: "desc" }, { id: "desc" }], select: { id: true } });
    expect(await walk(listInvoicesRoute, "/api/invoices")).toEqual(sales.map((s) => s.id));
    const purchases = await prisma.purchaseInvoice.findMany({ where: { userId: user.id }, orderBy: [{ dueDate: "asc" }, { id: "asc" }], select: { id: true } });
    expect(await walk(listPurchases, "/api/purchase-invoices")).toEqual(purchases.map((p) => p.id));

    const legacy = await listInvoicesRoute(req("/api/invoices"));
    const legacyBody = await readJson<Record<string, unknown>>(legacy);
    expect(legacyBody).not.toHaveProperty("nextCursor");
    expect((await listInvoicesRoute(req("/api/invoices", { "if-none-match": legacy.headers.get("etag")! }))).status).toBe(304);
    expect((await listPurchases(req("/api/purchase-invoices?cursor=x&limit=2"))).status).toBe(400);
  });
});

describe("GET /api/bootstrap", () => {
  it("is 401 without a session", async () => {
    expect((await bootstrap(buildRequest("GET", "/api/bootstrap"))).status).toBe(401);
  });

  it("returns the user, the same dataVersion and the same counts as their own endpoints", async () => {
    const customer = await createCustomer(user.id, { name: "Asiakas Oy" });
    await createInvoice(user.id, { customerId: customer.id, issueDate: "2026-03-10", lines: [{ description: "Työ", quantity: 1, unitPrice: 10, vatRate: 25.5 }] });
    await createPurchaseInvoice(user.id, { supplierName: "Toimittaja", issueDate: "2026-02-01", dueDate: "2026-03-01", gross: 20 });
    await createReceipt(user.id, { reviewStatus: "pending" });
    await createReceipt(user.id);

    const response = await bootstrap(req("/api/bootstrap"));
    expect(response.status).toBe(200);
    const body = await readJson<{ user: { userId: string }; dataVersion: number; counts: Record<string, unknown> }>(response);
    expect(body.user.userId).toBe(user.id);
    expect(body.dataVersion).toBe((await readJson<{ dataVersion: number }>(await syncVersion(req("/api/sync/version")))).dataVersion);
    expect(body.dataVersion).toBeGreaterThan(0);
    expect(body.counts.receipts).toEqual({ pending: 1 });
    expect(body.counts.invoices).toEqual((await readJson<{ counts: unknown }>(await invoiceCounts(req("/api/invoices/counts")))).counts);
    expect(body.counts.purchaseInvoices).toEqual((await readJson<{ counts: unknown }>(await purchaseCounts(req("/api/purchase-invoices/counts")))).counts);
    expect((await bootstrap(req("/api/bootstrap", { "if-none-match": response.headers.get("etag")! }))).status).toBe(304);
  });
});

describe("Koti and report cache (lib/books-cache.ts)", () => {
  it("shows a new receipt on the next open, never the cached figure", async () => {
    await createReceipt(user.id, { date: "2026-05-10", totalAmountCents: 10_000 });
    const open = async () => readJson<{ receiptCount: number; vat: { ytdRevenue: number } }>(await dashboard(req("/api/dashboard?month=2026-05")));
    expect((await open()).receiptCount).toBe(1);
    expect((await open()).receiptCount).toBe(1);
    await createReceipt(user.id, { date: "2026-05-11", totalAmountCents: 5_000 });
    expect((await open()).receiptCount).toBe(2);
    const ytdBefore = (await open()).vat.ytdRevenue;
    await createReceipt(user.id, { type: "tulo", date: "2026-05-12", totalAmountCents: 12_550 });
    expect((await open()).vat.ytdRevenue).toBeGreaterThan(ytdBefore);

    const report = async () => readJson<{ total: { expenseGross?: number; expenseGrossCents?: number } & Record<string, number> }>(
      await profitLoss(req("/api/reports/profit-loss?from=2026-01&to=2026-12"))
    );
    const before = JSON.stringify((await report()).total);
    await createReceipt(user.id, { date: "2026-06-01", totalAmountCents: 7_000 });
    expect(JSON.stringify((await report()).total)).not.toBe(before);
  });

  it("changes its stamp on a duplicate dismissal, which has no DataVersion trigger", async () => {
    const stamp = await readBooksStamp(user.id);
    await prisma.automationEvent.create({
      data: { userId: user.id, kind: DUPLICATE_DISMISSED_KIND, resourceType: "receipt", resourceId: "r", newValue: "p", reason: "testi" },
    });
    expect(await readBooksStamp(user.id)).not.toBe(stamp);
  });
});

describe("GET /api/receipts/[id]/file/preview?w=", () => {
  it("serves 160 and 320 px copies with an ETag, 304 on revalidation, 400 for another width", async () => {
    const width = 1200, height = 1600;
    const pixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 2654435761) % 251;
    const original = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    const { storageKey, absolutePath } = await writePrivateUpload(user.id, ".jpg", original);
    const receipt = await createReceipt(user.id);
    await prisma.receipt.update({ where: { id: receipt.id }, data: { filePath: storageKey, fileName: "kuitti.jpg" } });
    const ask = (query: string, headers?: Record<string, string>) =>
      preview(req(`/api/receipts/${receipt.id}/file/preview${query}`, headers), routeContext({ id: receipt.id }));

    const page = await readJson<Page>(await listReceipts(req("/api/receipts?cursor=")));
    expect(page.receipts[0].thumbnailUrl).toBe(`/api/receipts/${receipt.id}/file/preview?w=160`);

    for (const side of [160, 320]) {
      const response = await ask(`?w=${side}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("private");
      const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      expect(Math.max(meta.width!, meta.height!)).toBe(side);
      expect(fs.existsSync(`${absolutePath}.${side}.jpg`)).toBe(true);
      const again = await ask(`?w=${side}`, { "if-none-match": response.headers.get("etag")! });
      expect(again.status).toBe(304);
    }
    expect((await ask("?w=161")).status).toBe(400);

    await removeUserUpload(user.id, storageKey);
    expect(fs.existsSync(`${absolutePath}.160.jpg`)).toBe(false);
    expect(fs.existsSync(`${absolutePath}.320.jpg`)).toBe(false);
  });
});
