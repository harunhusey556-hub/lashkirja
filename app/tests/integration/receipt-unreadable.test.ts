import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as uploadReceipt } from "@/app/api/receipts/route";
import { POST as inbox } from "@/app/api/receipts/inbox/route";
import { POST as saveReceipt } from "@/app/api/receipts/save/route";
import { GET as getJob } from "@/app/api/jobs/[id]/route";
import { prisma } from "@/lib/db";
import { processDocumentJob, setDocumentExtractorForTests } from "@/lib/document-jobs";
import { ReceiptExtractionError } from "@/lib/ai";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

const CALM_LINE = "Kuvasta ei voitu lukea tietoja, täytä ne itse.";

let user: TestUser;
let cookie: string;

function jpeg(extra = 0): File {
  return new File([Uint8Array.from([0xff, 0xd8, 0xff, extra, 0xd9])], "kuitti.jpg", {
    type: "image/jpeg",
  });
}

async function finish(jobId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await processDocumentJob(jobId);
    const job = await prisma.backgroundJob.findUnique({ where: { id: jobId } });
    if (job?.status === "done" || job?.status === "failed") return job;
  }
  throw new Error("job did not finish");
}

async function postUpload(file: File) {
  const form = new FormData();
  form.set("file", file);
  return uploadReceipt(buildFormRequest("/api/receipts", form, { cookie }));
}

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  // The dev box and the production PC have no OCR: the extractor finds no text.
  setDocumentExtractorForTests(async () => {
    throw new ReceiptExtractionError("NO_TEXT", "Kuitista ei saatu luettua tekstiä.");
  });
});

afterEach(() => {
  setDocumentExtractorForTests(null);
});

describe("F04: a photo without readable text is not a dead end", () => {
  it("finishes the job as done with empty fields, keeps the upload claimable and the receipt can be typed in", async () => {
    const uploaded = await readJson(await postUpload(jpeg(1)));
    expect(uploaded.jobId).toBeTruthy();

    const job = await finish(uploaded.jobId);
    expect(job?.status).toBe("done");
    expect(job?.error).toBeNull();

    const viewed = await readJson(
      await getJob(
        buildRequest("GET", `/api/jobs/${uploaded.jobId}`, undefined, { cookie }),
        routeContext({ id: uploaded.jobId })
      )
    );
    expect(viewed.job.status).toBe("done");
    expect(viewed.job.extracted).toMatchObject({
      vendor: null,
      date: null,
      totalAmount: null,
      vatDetails: [],
      unreadable: true,
    });

    const upload = await prisma.upload.findUnique({ where: { id: uploaded.uploadId } });
    expect(upload?.claimedAt).toBeNull();

    const saved = await saveReceipt(
      buildRequest(
        "POST",
        "/api/receipts/save",
        {
          uploadId: uploaded.uploadId,
          vendor: "Kahvila",
          date: "2026-09-20",
          totalAmount: 12.5,
          category: "muut",
          type: "meno",
        },
        { cookie }
      )
    );
    expect(saved.status).toBe(200);
    const receipt = await prisma.receipt.findFirstOrThrow({ where: { uploadId: uploaded.uploadId } });
    expect(receipt.fileName).toBe("kuitti.jpg");
    expect(receipt.source).toBe("manual");
    // Typed in by hand, so no recognition score: the editor must not mark its fields as uncertain (V11).
    expect(receipt.confidence).toBeNull();
  });

  it("answers the same photo again with done and the same empty form instead of a new job", async () => {
    const first = await readJson(await postUpload(jpeg(2)));
    await finish(first.jobId);
    const again = await readJson(await postUpload(jpeg(2)));
    expect(again.status).toBe("done");
    expect(again.extracted).toMatchObject({ vendor: null, totalAmount: null, unreadable: true });
  });

  it("keeps the offline path alike: a pending receipt with the same calm line", async () => {
    const form = new FormData();
    form.set("file", jpeg(3));
    form.set("capturedAt", new Date().toISOString());
    const queued = await readJson(
      await inbox(
        buildFormRequest("/api/receipts/inbox", form, {
          cookie,
          headers: { "idempotency-key": "queue-unreadable-1" },
        })
      )
    );
    const job = await finish(queued.jobId);
    expect(job?.status).toBe("done");
    const receipt = await prisma.receipt.findFirstOrThrow({ where: { uploadId: queued.uploadId } });
    expect(receipt).toMatchObject({
      source: "app_capture",
      reviewStatus: "pending",
      vendor: null,
      totalAmountCents: null,
      notes: CALM_LINE,
    });
  });

  it("still fails the job for a genuinely broken file", async () => {
    setDocumentExtractorForTests(async () => {
      throw new ReceiptExtractionError("UNSUPPORTED_FILE", "Tiedoston sisältö ei vastaa tuettua muotoa");
    });
    const uploaded = await readJson(await postUpload(jpeg(4)));
    const job = await finish(uploaded.jobId);
    expect(job?.status).toBe("failed");
  });
});
