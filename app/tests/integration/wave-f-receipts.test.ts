import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { POST as uploadReceipt } from "@/app/api/receipts/route";
import { GET as getJob } from "@/app/api/jobs/[id]/route";
import { POST as saveReceipt } from "@/app/api/receipts/save/route";
import { PATCH as patchReceipt } from "@/app/api/receipts/[id]/route";
import { POST as batchApprove } from "@/app/api/receipts/batch-approve/route";
import { POST as batchDelete } from "@/app/api/receipts/batch-delete/route";
import { GET as listWork } from "@/app/api/work-queue/route";
import { POST as saveRule } from "@/app/api/vendor-rules/route";
import { POST as undoRule } from "@/app/api/vendor-rules/undo/route";
import { prisma } from "@/lib/db";
import { processDocumentJob, setDocumentExtractorForTests } from "@/lib/document-jobs";
import { confirmMatch } from "@/lib/matching";
import type { ExtractedReceipt } from "@/lib/ai";
import {
  createReceipt,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

const extracted: ExtractedReceipt = {
  vendor: "K-Market",
  date: "2026-02-02",
  totalAmount: 12.5,
  vatDetails: [{ rate: 14, amount: 1.5 }],
  category: "muut",
  notes: null,
  type: "meno",
  reference: null,
  invoiceNumber: null,
  source: "ocr",
  provenance: "local-ocr",
  confidence: 0.42,
};

function jpeg(extra = 0): File {
  return new File([Uint8Array.from([0xff, 0xd8, 0xff, extra, 0xd9])], "kuitti.jpg", {
    type: "image/jpeg",
  });
}

async function postFile(file: File) {
  const form = new FormData();
  form.set("file", file);
  return uploadReceipt(buildFormRequest("/api/receipts", form, { cookie }));
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
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  setDocumentExtractorForTests(async () => extracted);
});

afterEach(() => {
  setDocumentExtractorForTests(null);
});

describe("wave F receipts", () => {
  it("stores OCR as a job and opens the existing document on a duplicate checksum", async () => {
    const uploaded = await postFile(jpeg());
    expect(uploaded.status).toBe(200);
    const body = await readJson(uploaded);
    expect(body.jobId).toBeTruthy();
    expect(body.extracted).toBeUndefined();
    expect(body.status).not.toBe("done");

    const job = await finish(body.jobId);
    expect(job?.status).toBe("done");
    const viewed = await getJob(
      buildRequest("GET", `/api/jobs/${body.jobId}`, undefined, { cookie }),
      routeContext({ id: body.jobId })
    );
    expect((await readJson(viewed)).job.extracted.vendor).toBe("K-Market");

    const saved = await saveReceipt(
      buildRequest(
        "POST",
        "/api/receipts/save",
        {
          uploadId: body.uploadId,
          vendor: "K-Market",
          date: "2026-02-02",
          totalAmount: 12.5,
          category: "muut",
          type: "meno",
          vatDetails: [{ rate: 14, amount: 1.5 }],
        },
        { cookie }
      )
    );
    expect(saved.status).toBe(200);
    const receiptId = (await readJson(saved)).receipt.id as string;

    const duplicate = await postFile(jpeg());
    expect(duplicate.status).toBe(409);
    const duplicateBody = await readJson(duplicate);
    expect(duplicateBody.code).toBe("DUPLICATE_DOCUMENT");
    expect(duplicateBody.receiptId).toBe(receiptId);
  });

  it("keeps a category correction out of permanent rules until asked", async () => {
    const receipt = await createReceipt(user.id, { vendor: "K-Market", category: "tarvikkeet" });
    const patched = await patchReceipt(
      buildRequest(
        "PATCH",
        `/api/receipts/${receipt.id}`,
        { category: "vuokrat", expectedUpdatedAt: receipt.updatedAt.toISOString() },
        { cookie }
      ),
      routeContext({ id: receipt.id })
    );
    expect(patched.status).toBe(200);
    const events = await prisma.automationEvent.findMany({
      where: { userId: user.id, resourceId: receipt.id, kind: "category" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.previousValue).toBe("tarvikkeet");
    expect(events[0]?.newValue).toBe("vuokrat");
    expect(events[0]?.reason).toBe("käyttäjän korjaus");
    expect(await prisma.vendorCategoryRule.count()).toBe(0);

    const saved = await saveRule(
      buildRequest("POST", "/api/vendor-rules", { vendor: "K-Market", category: "tarvikkeet" }, { cookie })
    );
    expect(saved.status).toBe(200);
    const uploaded = await postFile(jpeg(1));
    const body = await readJson(uploaded);
    const job = await finish(body.jobId);
    expect(job?.status).toBe("done");
    const payload = JSON.parse(job?.payload ?? "{}") as { extracted?: { category?: string } };
    expect(payload.extracted?.category).toBe("tarvikkeet");
    const ruleEvent = await prisma.automationEvent.findFirst({
      where: { userId: user.id, reason: "käyttäjän sääntö" },
    });
    expect(ruleEvent?.previousValue).toBe("muut");
    expect(ruleEvent?.newValue).toBe("tarvikkeet");

    const undone = await undoRule(
      buildRequest("POST", "/api/vendor-rules/undo", { vendor: "k-market" }, { cookie })
    );
    expect(undone.status).toBe(200);
    const rule = await prisma.vendorCategoryRule.findFirst({ where: { userId: user.id } });
    expect(rule?.active).toBe(false);
    expect(rule?.undoneAt).toBeTruthy();
  });

  it("records a match audit and reports partial batch results", async () => {
    const statement = await createStatementWithTransactions(user.id, {
      transactions: [{ date: "2026-03-01", amountCents: -1250, counterparty: "K-Market" }],
    });
    const receipt = await createReceipt(user.id, { date: "2026-03-01", totalAmountCents: 1250 });
    const tx = statement.transactions[0]!;
    await confirmMatch(user.id, tx.id, receipt.id, true);
    const matchEvent = await prisma.automationEvent.findFirst({
      where: { userId: user.id, kind: "match", resourceId: tx.id },
    });
    expect(matchEvent?.previousValue).toBe("unmatched");
    expect(matchEvent?.newValue).toBe("confirmed");
    expect(matchEvent?.reason).toBe("automaattinen täsmäytys");

    const pending = await createReceipt(user.id, { reviewStatus: "pending", date: "2026-03-02" });
    const approved = await batchApprove(
      buildRequest(
        "POST",
        "/api/receipts/batch-approve",
        { receiptIds: [pending.id, randomUUID()] },
        { cookie }
      )
    );
    expect(approved.status).toBe(200);
    const approveBody = await readJson(approved);
    expect(approveBody.updatedCount).toBe(1);
    expect(approveBody.failedCount).toBe(1);
    expect(approveBody.succeeded).toEqual([pending.id]);

    const openReceipt = await createReceipt(user.id, { date: "2026-03-04" });
    const lockedReceipt = await createReceipt(user.id, { date: "2026-01-15" });
    await prisma.user.update({
      where: { id: user.id },
      data: { booksLockedThrough: "2026-01" },
    });
    const deleted = await batchDelete(
      buildRequest(
        "POST",
        "/api/receipts/batch-delete",
        { receiptIds: [openReceipt.id, lockedReceipt.id, "missing"] },
        { cookie }
      )
    );
    expect(deleted.status).toBe(200);
    const deleteBody = await readJson(deleted);
    expect(deleteBody.deletedCount).toBe(1);
    expect(deleteBody.failedCount).toBe(2);
    expect(deleteBody.succeeded).toEqual([openReceipt.id]);
    expect(await prisma.receipt.findUnique({ where: { id: lockedReceipt.id } })).toBeTruthy();

    await prisma.receipt.update({
      where: { id: receipt.id },
      data: { totalAmountCents: 9999 },
    });
    await createStatementWithTransactions(user.id, {
      transactions: [{ date: "2026-03-08", amountCents: -333, counterparty: "Puuttuva" }],
    });
    const queue = await listWork(buildRequest("GET", "/api/work-queue", undefined, { cookie }));
    const queueBody = await readJson(queue);
    const kinds = queueBody.items.map((item: { kind: string }) => item.kind);
    expect(kinds).toContain("missing_document");
    expect(kinds).toContain("amount_mismatch");
  });
});
