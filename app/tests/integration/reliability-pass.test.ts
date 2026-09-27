import { sealData } from "iron-session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as me } from "@/app/api/auth/me/route";
import { POST as revokeSessions } from "@/app/api/auth/sessions/route";
import { POST as cancelJob } from "@/app/api/jobs/[id]/cancel/route";
import { POST as retryJob } from "@/app/api/jobs/[id]/retry/route";
import { prisma } from "@/lib/db";
import { issuePasswordReset, openAuthSession, resetPasswordWithToken } from "@/lib/account-security";
import { processDocumentJob, setDocumentExtractorForTests } from "@/lib/document-jobs";
import { createCustomer, updateCustomer } from "@/lib/customers";
import {
  failNextIdempotencyResponseForTests,
  hashIdempotencyPayload,
  IDEMPOTENCY_PROCESSING_MS,
  withIdempotency,
} from "@/lib/idempotency";
import { sendInvoiceByEmail } from "@/lib/invoice-mail";
import { createInvoice, updateInvoice } from "@/lib/sales-invoices";
import { sessionOptions, type SessionData } from "@/lib/session";
import type { ExtractedReceipt } from "@/lib/ai";
import { encrypt } from "@/lib/encryption";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;

async function seal(data: SessionData): Promise<string> {
  const sealed = await sealData(data, {
    password: sessionOptions.password as string,
    ttl: sessionOptions.ttl,
  });
  return `${sessionOptions.cookieName}=${sealed}`;
}

function extracted(vendor: string): ExtractedReceipt {
  return {
    vendor,
    date: "2026-01-02",
    totalAmount: 12,
    vatDetails: [],
    category: "muu",
    notes: null,
    type: "meno",
    reference: null,
    invoiceNumber: null,
    source: "ocr",
    provenance: "local-ocr",
    confidence: 0.4,
  };
}

async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${label}`);
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  failNextIdempotencyResponseForTests(0);
  setDocumentExtractorForTests(null);
});

afterEach(() => {
  failNextIdempotencyResponseForTests(0);
  setDocumentExtractorForTests(null);
});

describe("legacy sessions", () => {
  it("refuses a revoked session id, a legacy cookie after logout-all, and every old cookie after a password reset", async () => {
    const legacy = await sessionCookie(user);
    const open = await me(buildRequest("GET", "/api/auth/me", undefined, { cookie: legacy }));
    expect(open.status).toBe(200);

    const row = await openAuthSession(user.id, "TestAgent");
    const tracked = await seal({ userId: user.id, email: user.email, firstName: "Testi", sessionId: row.id });
    expect((await me(buildRequest("GET", "/api/auth/me", undefined, { cookie: tracked }))).status).toBe(200);

    await prisma.authSession.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    expect((await me(buildRequest("GET", "/api/auth/me", undefined, { cookie: tracked }))).status).toBe(401);

    const fresh = await openAuthSession(user.id, "TestAgent");
    const current = await seal({
      userId: user.id,
      email: user.email,
      firstName: "Testi",
      sessionId: fresh.id,
    });
    const revoked = await revokeSessions(
      buildRequest("POST", "/api/auth/sessions", { scope: "all" }, { cookie: current })
    );
    expect(revoked.status).toBe(200);
    expect((await me(buildRequest("GET", "/api/auth/me", undefined, { cookie: legacy }))).status).toBe(401);
    expect((await me(buildRequest("GET", "/api/auth/me", undefined, { cookie: current }))).status).toBe(401);

    const again = await createUser({ email: "reset@example.com" });
    const againLegacy = await sessionCookie(again);
    const againRow = await openAuthSession(again.id, "TestAgent");
    const againTracked = await seal({
      userId: again.id,
      email: again.email,
      firstName: "Testi",
      sessionId: againRow.id,
    });
    const token = await issuePasswordReset(again.id);
    await resetPasswordWithToken(token, "uusi-salasana-1");
    expect((await me(buildRequest("GET", "/api/auth/me", undefined, { cookie: againLegacy }))).status).toBe(401);
    expect((await me(buildRequest("GET", "/api/auth/me", undefined, { cookie: againTracked }))).status).toBe(401);

    const relogin = await openAuthSession(again.id, "TestAgent");
    const reloginCookie = await seal({
      userId: again.id,
      email: again.email,
      firstName: "Testi",
      sessionId: relogin.id,
    });
    expect((await me(buildRequest("GET", "/api/auth/me", undefined, { cookie: reloginCookie }))).status).toBe(200);
  });
});

describe("idempotency", () => {
  it("keeps a single customer when the response row cannot be stored, and refuses a different body", async () => {
    const body = { name: "Anna Asiakas" };
    const hash = hashIdempotencyPayload(body);
    failNextIdempotencyResponseForTests(1);
    await expect(
      withIdempotency(
        user.id,
        "customer.create",
        "key-1",
        async (tx) => ({
          status: 201,
          body: { customer: await createCustomer(user.id, body, tx ?? undefined) },
        }),
        hash
      )
    ).rejects.toThrow(/response was not stored/);
    expect(await prisma.customer.count()).toBe(0);

    const created = await withIdempotency(
      user.id,
      "customer.create",
      "key-1",
      async (tx) => ({
        status: 201,
        body: { customer: await createCustomer(user.id, body, tx ?? undefined) },
      }),
      hash
    );
    expect(created.replayed).toBe(false);
    expect(await prisma.customer.count()).toBe(1);

    const replayed = await withIdempotency(
      user.id,
      "customer.create",
      "key-1",
      async () => {
        throw new Error("must not create again");
      },
      hash
    );
    expect(replayed.replayed).toBe(true);
    expect(await prisma.customer.count()).toBe(1);

    await expect(
      withIdempotency(
        user.id,
        "customer.create",
        "key-1",
        async (tx) => ({
          status: 201,
          body: { customer: await createCustomer(user.id, { name: "Toinen" }, tx ?? undefined) },
        }),
        hashIdempotencyPayload({ name: "Toinen" })
      )
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH", statusCode: 409 });
    expect(await prisma.customer.count()).toBe(1);
  });

  it("reclaims a processing row that outlived the request and refuses a live one", async () => {
    await prisma.idempotencyRecord.create({
      data: {
        userId: user.id,
        scope: "customer.create",
        key: "stuck",
        statusCode: 0,
        body: "",
        requestHash: hashIdempotencyPayload({ name: "Stuck" }),
        createdAt: new Date(Date.now() - IDEMPOTENCY_PROCESSING_MS - 1000),
      },
    });
    const recovered = await withIdempotency(
      user.id,
      "customer.create",
      "stuck",
      async (tx) => ({
        status: 201,
        body: { customer: await createCustomer(user.id, { name: "Stuck" }, tx ?? undefined) },
      }),
      hashIdempotencyPayload({ name: "Stuck" })
    );
    expect(recovered.replayed).toBe(false);
    expect(await prisma.customer.count({ where: { name: "Stuck" } })).toBe(1);

    await prisma.idempotencyRecord.create({
      data: {
        userId: user.id,
        scope: "customer.create",
        key: "live",
        statusCode: 0,
        body: "",
        requestHash: "",
      },
    });
    await expect(
      withIdempotency(user.id, "customer.create", "live", async () => ({ status: 201, body: { ok: true } }))
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await prisma.customer.count({ where: { name: "Stuck" } })).toBe(1);
  });
});

describe("optimistic concurrency", () => {
  it("lets one of two same-version customer updates win and returns 409 to the other", async () => {
    const customer = await createCustomer(user.id, { name: "Alkuperäinen" });
    const [first, second] = await Promise.allSettled([
      updateCustomer(user.id, customer.id, { name: "Laite A", expectedUpdatedAt: customer.updatedAt }),
      updateCustomer(user.id, customer.id, { name: "Laite B", expectedUpdatedAt: customer.updatedAt }),
    ]);
    const results = [first, second];
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ statusCode: 409 });
    }
    const stored = await prisma.customer.findUnique({ where: { id: customer.id } });
    expect(["Laite A", "Laite B"]).toContain(stored?.name);
  });

  it("applies invoice line edits in one versioned transaction", async () => {
    const customer = await createCustomer(user.id, { name: "Anna", email: "anna@example.fi" });
    const invoice = await createInvoice(user.id, {
      customerId: customer.id,
      issueDate: "2026-01-15",
      lines: [{ description: "Vanha", quantity: 1, unitPrice: 10, vatRate: 25.5 }],
    });
    const [first, second] = await Promise.allSettled([
      updateInvoice(user.id, invoice.id, {
        expectedUpdatedAt: invoice.updatedAt,
        lines: [{ description: "Laite A", quantity: 1, unitPrice: 10, vatRate: 25.5 }],
      }),
      updateInvoice(user.id, invoice.id, {
        expectedUpdatedAt: invoice.updatedAt,
        lines: [{ description: "Laite B", quantity: 2, unitPrice: 10, vatRate: 25.5 }],
      }),
    ]);
    expect([first, second].filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect([first, second].filter((result) => result.status === "rejected")).toHaveLength(1);
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: invoice.id } });
    expect(lines).toHaveLength(1);
    expect(["Laite A", "Laite B"]).toContain(lines[0]?.description);
  });
});

describe("invoice send lock", () => {
  it("blocks an edit while sending and stores the snapshot hash of the frozen document", async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: { invoiceIban: "FI2112345600000785", businessName: "Liisan Ripsistudio" },
    });
    await prisma.imapAccount.create({
      data: {
        userId: user.id,
        email: "liisa@example.fi",
        host: "imap.example.test",
        port: 993,
        encryptedPass: encrypt("secret"),
      },
    });
    const customer = await createCustomer(user.id, { name: "Anna", email: "anna@example.fi" });
    const invoice = await createInvoice(user.id, {
      customerId: customer.id,
      issueDate: "2026-01-15",
      lines: [{ description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
    });

    let release: () => void = () => undefined;
    let opened: () => void = () => undefined;
    const openedGate = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = sendInvoiceByEmail(user.id, invoice.id, {}, {
      deliver: async () => {
        opened();
        await hold;
        return { messageId: "msg-1", from: "liisa@example.fi", to: "anna@example.fi", accepted: ["anna@example.fi"] };
      },
    });
    await openedGate;

    await expect(
      updateInvoice(user.id, invoice.id, {
        expectedUpdatedAt: invoice.updatedAt,
        lines: [{ description: "Muokattu kesken lähetyksen", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
      })
    ).rejects.toMatchObject({ code: "SEND_IN_PROGRESS", statusCode: 409 });

    release();
    const sent = await sending;
    expect(sent.recorded).toBe(true);

    const stored = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    const attempt = await prisma.invoiceEmailSend.findFirst({ where: { invoiceId: invoice.id } });
    expect(stored?.status).toBe("sent");
    expect(stored?.sendLockToken).toBeNull();
    expect(stored?.sentContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.sentContentHash).toBe(attempt?.contentHash);
    const snapshot = JSON.parse(stored?.sentDocumentSnapshot ?? "{}") as {
      lines: Array<{ description: string }>;
    };
    expect(snapshot.lines[0]?.description).toBe("Ripsienpidennys");
    expect(attempt?.documentSnapshot).toBe(stored?.sentDocumentSnapshot);
  });

  it("treats a send whose outcome was not stored as ambiguous, not as a safe resend", async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: { invoiceIban: "FI2112345600000785" },
    });
    await prisma.imapAccount.create({
      data: {
        userId: user.id,
        email: "liisa@example.fi",
        host: "imap.example.test",
        port: 993,
        encryptedPass: encrypt("secret"),
      },
    });
    const customer = await createCustomer(user.id, { name: "Anna", email: "anna@example.fi" });
    const invoice = await createInvoice(user.id, {
      customerId: customer.id,
      issueDate: "2026-01-15",
      lines: [{ description: "Työ", quantity: 1, unitPrice: 50, vatRate: 25.5 }],
    });
    const first = await sendInvoiceByEmail(
      user.id,
      invoice.id,
      {},
      {
        deliver: async () => ({
          messageId: "msg-ambiguous",
          from: "liisa@example.fi",
          to: "anna@example.fi",
          accepted: ["anna@example.fi"],
        }),
        persist: async () => false,
      }
    );
    expect(first.recorded).toBe(false);
    expect(first.notice).toBeTruthy();
    await expect(
      sendInvoiceByEmail(user.id, invoice.id, {}, {
        deliver: async () => {
          throw new Error("must not send again");
        },
      })
    ).rejects.toMatchObject({ code: "SEND_AMBIGUOUS" });
  });
});

describe("document analysis ownership", () => {
  it("does not let a cancelled run write, and a retry's result survives the stale run", async () => {
    const upload = await prisma.upload.create({
      data: {
        userId: user.id,
        purpose: "receipt",
        storageKey: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf",
        originalName: "kuitti.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        sha256: "abc",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const job = await prisma.backgroundJob.create({
      data: {
        userId: user.id,
        kind: "document_analysis",
        status: "pending",
        title: "Kuitin analysointi",
        resourceType: "upload",
        resourceId: upload.id,
        payload: JSON.stringify({
          uploadId: upload.id,
          mimeType: "application/pdf",
          storageKey: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf",
          originalName: "kuitti.pdf",
          profileContext: "",
          vendorPriors: "",
        }),
      },
    });

    const waiters: Array<(value: ExtractedReceipt) => void> = [];
    setDocumentExtractorForTests(
      () =>
        new Promise((resolve) => {
          waiters.push(resolve);
        })
    );

    const cookie = await sessionCookie(user);
    const firstRun = processDocumentJob(job.id);
    await waitFor(async () => waiters.length === 1, "first extractor");

    const cancel = await cancelJob(
      buildRequest("POST", `/api/jobs/${job.id}/cancel`, undefined, { cookie }),
      routeContext({ id: job.id })
    );
    expect(cancel.status).toBe(200);

    const retry = await retryJob(
      buildRequest("POST", `/api/jobs/${job.id}/retry`, undefined, { cookie }),
      routeContext({ id: job.id })
    );
    expect(retry.status).toBe(200);
    expect((await readJson(retry)).status).toBe("pending");
    if ((await prisma.backgroundJob.findUnique({ where: { id: job.id } }))?.status === "pending") {
      void processDocumentJob(job.id);
    }
    await waitFor(async () => waiters.length >= 2, "retry extractor");

    const retryToken = (await prisma.backgroundJob.findUnique({ where: { id: job.id } }))?.attemptToken;
    expect(retryToken).toBeTruthy();
    waiters[1](extracted("Uusi"));
    await waitFor(async () => {
      const row = await prisma.upload.findUnique({ where: { id: upload.id } });
      return Boolean(row?.extractedJson?.includes("Uusi"));
    }, "retry write");

    waiters[0](extracted("Vanha"));
    await firstRun;

    const stored = await prisma.upload.findUnique({ where: { id: upload.id } });
    expect(stored?.extractedJson).toContain("Uusi");
    expect(stored?.extractedJson).not.toContain("Vanha");
    const finished = await prisma.backgroundJob.findUnique({ where: { id: job.id } });
    expect(finished?.status).toBe("done");
    expect(await prisma.automationEvent.count()).toBe(0);
  });
});
