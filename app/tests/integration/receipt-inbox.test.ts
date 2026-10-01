import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as issueToken } from "@/app/api/auth/token/route";
import { POST as inbox } from "@/app/api/receipts/inbox/route";
import { prisma } from "@/lib/db";
import { processDocumentJob, setDocumentExtractorForTests } from "@/lib/document-jobs";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { MAX_RECEIPT_REQUEST_BYTES } from "@/lib/storage";
import type { ExtractedReceipt } from "@/lib/ai";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, sessionCookie } from "./helpers/http";

const APP_ORIGIN = "capacitor://localhost";
const CAPTURED_AT = "2026-09-20T08:30:00.000Z";

const extracted: ExtractedReceipt = {
  vendor: "K-Market",
  date: "2026-09-20",
  totalAmount: 8.9,
  vatDetails: [{ rate: 14, amount: 1.1 }],
  category: "muut",
  notes: null,
  type: "meno",
  reference: null,
  invoiceNumber: null,
  source: "ocr",
  provenance: "local-ocr",
  confidence: 0.6,
};

let user: TestUser;
let cookie: string;

function jpeg(extra = 0): File {
  return new File([Uint8Array.from([0xff, 0xd8, 0xff, extra, 0xd9])], "kuitti.jpg", {
    type: "image/jpeg",
  });
}

function inboxForm(file: File, capturedAt = CAPTURED_AT): FormData {
  const form = new FormData();
  form.set("file", file);
  form.set("capturedAt", capturedAt);
  return form;
}

async function postInbox(
  file: File,
  idempotencyKey: string,
  options: { cookie?: string; origin?: string; headers?: Record<string, string> } = {}
) {
  return inbox(
    buildFormRequest("/api/receipts/inbox", inboxForm(file), {
      cookie: options.cookie ?? cookie,
      origin: options.origin,
      headers: { "idempotency-key": idempotencyKey, ...(options.headers ?? {}) },
    })
  );
}

async function finish(jobId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await processDocumentJob(jobId);
    const job = await prisma.backgroundJob.findUnique({ where: { id: jobId } });
    if (job?.status === "done" || job?.status === "failed") return job;
  }
  throw new Error("job did not finish");
}

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  setDocumentExtractorForTests(async () => extracted);
});

afterEach(() => {
  setDocumentExtractorForTests(null);
});

describe("POST /api/receipts/inbox", () => {
  it("queues a job and turns it into a pending app_capture receipt on completion", async () => {
    const response = await postInbox(jpeg(1), "queue-item-1");
    expect(response.status).toBe(201);
    const body = await readJson<{ status: string; jobId: string; uploadId: string }>(response);
    expect(body.status).toBe("queued");
    expect(body.jobId).toBeTruthy();
    expect(body.uploadId).toBeTruthy();

    const job = await finish(body.jobId);
    expect(job?.status).toBe("done");

    const receipt = await prisma.receipt.findFirst({ where: { userId: user.id, uploadId: body.uploadId } });
    expect(receipt).toMatchObject({
      source: "app_capture",
      reviewStatus: "pending",
      vendor: "K-Market",
      totalAmountCents: 890,
    });

    const upload = await prisma.upload.findUniqueOrThrow({ where: { id: body.uploadId } });
    expect(upload.claimedAt).not.toBeNull();
  });

  it("marks the job failed even when the fallback receipt insert collides (final review M2)", async () => {
    setDocumentExtractorForTests(async () => {
      throw new Error("ei toiminut");
    });
    const body = await readJson<{ jobId: string; uploadId: string }>(
      await postInbox(jpeg(30), "queue-item-m2")
    );

    // Simulate the same photo already having a Receipt row - e.g. already
    // saved by the web editor, or a concurrent inbox retry that beat this
    // job to it. createPendingInboxReceipt's fallback insert then collides
    // on the unique Receipt.uploadId (P2002). Before the fix this rolled
    // back the "failed" status update in the same transaction, leaving the
    // job stuck "running" forever (until isStuckRunning() resets it and the
    // extractor - possibly a paid AI call - runs again and fails again).
    await prisma.receipt.create({
      data: {
        userId: user.id,
        uploadId: body.uploadId,
        filePath: "already-saved.jpg",
        fileName: "already-saved.jpg",
        source: "manual",
      },
    });

    const job = await finish(body.jobId);
    expect(job?.status).toBe("failed");

    const receiptCount = await prisma.receipt.count({ where: { uploadId: body.uploadId } });
    expect(receiptCount).toBe(1);
  });

  it("returns the same staged upload and pending job for the same bytes, and only one receipt", async () => {
    const first = await readJson<{ jobId: string; uploadId: string }>(
      await postInbox(jpeg(2), "queue-item-a")
    );
    await finish(first.jobId);

    const second = await readJson<{ status: string; receiptId: string | null }>(
      await postInbox(jpeg(2), "queue-item-b")
    );
    expect(second.status).toBe("duplicate");

    expect(await prisma.receipt.count({ where: { userId: user.id } })).toBe(1);
  });

  it("still creates a pending receipt with the manual-entry note when extraction fails", async () => {
    setDocumentExtractorForTests(async () => {
      throw new Error("ei toiminut");
    });
    const body = await readJson<{ jobId: string; uploadId: string }>(
      await postInbox(jpeg(3), "queue-item-fail")
    );
    const job = await finish(body.jobId);
    expect(job?.status).toBe("failed");

    const receipt = await prisma.receipt.findFirst({ where: { userId: user.id, uploadId: body.uploadId } });
    expect(receipt).toMatchObject({
      source: "app_capture",
      reviewStatus: "pending",
      totalAmountCents: null,
      notes: "Kuvasta ei voitu lukea tietoja, täytä ne itse.",
    });
  });

  it("429s with Retry-After on the 21st upload in 10 minutes, sharing the bucket with POST /api/receipts", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 21; i += 1) {
      last = await postInbox(jpeg(i), `queue-item-rate-${i}`);
    }
    expect(last?.status).toBe(429);
    const retryAfter = Number(last?.headers.get("Retry-After"));
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("rejects a request with no Idempotency-Key header", async () => {
    const response = await inbox(
      buildFormRequest("/api/receipts/inbox", inboxForm(jpeg(9)), { cookie })
    );
    expect(response.status).toBe(400);
  });

  it("rejects a missing or malformed capturedAt", async () => {
    const form = new FormData();
    form.set("file", jpeg(10));
    form.set("capturedAt", "not-a-date");
    const response = await inbox(
      buildFormRequest("/api/receipts/inbox", form, {
        cookie,
        headers: { "idempotency-key": "queue-item-bad-date" },
      })
    );
    expect(response.status).toBe(400);
  });

  it("rejects an oversized body with 413, based on Content-Length (final review I2)", async () => {
    // The multipart body's real byte count doesn't matter for this check -
    // rejectOversizedContentLength runs before req.formData() is even
    // called, purely off the Content-Length header, exactly like a request
    // that genuinely exceeds MAX_RECEIPT_REQUEST_BYTES would report.
    const response = await inbox(
      buildFormRequest("/api/receipts/inbox", inboxForm(jpeg(20)), {
        cookie,
        headers: {
          "idempotency-key": "queue-item-oversized",
          "content-length": String(MAX_RECEIPT_REQUEST_BYTES + 1024 * 1024),
        },
      })
    );
    expect(response.status).toBe(413);
  });

  it("an 11 MB file with invalid content is rejected as 415/400, never 500 (final review I2)", async () => {
    const bytes = new Uint8Array(11 * 1024 * 1024);
    // Deterministic pseudo-random fill: no magic-byte signature this file
    // format detector recognises, and near-certain to contain a 0x00 byte,
    // which rules out the text/CSV/XML fallback path too - detectFile()
    // returns null, so this is a genuinely unsupported file, not an
    // accident of matching some other format.
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = (i * 2654435761) % 256;
    }
    const bigFile = new File([bytes], "kuitti.jpg", { type: "image/jpeg" });

    const response = await inbox(
      buildFormRequest("/api/receipts/inbox", inboxForm(bigFile), {
        cookie,
        headers: { "idempotency-key": "queue-item-11mb" },
      })
    );
    expect(response.status).not.toBe(500);
    expect([400, 415]).toContain(response.status);
  });

  it("rejects a capturedAt more than a small skew into the future (final review M4)", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const response = await inbox(
      buildFormRequest("/api/receipts/inbox", inboxForm(jpeg(21), future), {
        cookie,
        headers: { "idempotency-key": "queue-item-future-date" },
      })
    );
    expect(response.status).toBe(400);
  });

  it("rejects a capturedAt more than a year in the past (final review M4)", async () => {
    const ancient = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const response = await inbox(
      buildFormRequest("/api/receipts/inbox", inboxForm(jpeg(22), ancient), {
        cookie,
        headers: { "idempotency-key": "queue-item-ancient-date" },
      })
    );
    expect(response.status).toBe(400);
  });

  it("accepts a cookie-less bearer request from the app origin", async () => {
    const password = "salasana1234";
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(password, 4) },
    });
    const tokenResponse = await issueToken(
      buildRequest("POST", "/api/auth/token", { email: user.email, password })
    );
    const { token } = await readJson<{ token: string }>(tokenResponse);

    const response = await inbox(
      buildFormRequest("/api/receipts/inbox", inboxForm(jpeg(11)), {
        origin: APP_ORIGIN,
        headers: { "idempotency-key": "queue-item-app", authorization: `Bearer ${token}` },
      })
    );
    expect(response.status).toBe(201);
    const body = await readJson<{ status: string; jobId: string }>(response);
    expect(body.status).toBe("queued");
  });
});
