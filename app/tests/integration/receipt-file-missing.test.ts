import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as preview } from "@/app/api/receipts/[id]/file/preview/route";
import { GET as file } from "@/app/api/receipts/[id]/file/route";
import { prisma } from "@/lib/db";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, routeContext, sessionCookie } from "./helpers/http";

/** 205 production receipts drafted from bank rows carry filePath "auto-generated" (2026-10-08). */

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

describe("a receipt without a stored file", () => {
  it("answers 404 for its preview and its file, never 500, and logs nothing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const receipt = await createReceipt(user.id, { totalAmountCents: 1_000, reviewStatus: "approved" });
    for (const filePath of ["auto-generated", "/tmp/demo-1.pdf"]) {
      await prisma.receipt.update({ where: { id: receipt.id }, data: { filePath } });
      const previewResponse = await preview(
        buildRequest("GET", `/api/receipts/${receipt.id}/file/preview`, undefined, { cookie }),
        routeContext({ id: receipt.id })
      );
      expect(previewResponse.status, filePath).toBe(404);
      const fileResponse = await file(
        buildRequest("GET", `/api/receipts/${receipt.id}/file`, undefined, { cookie }),
        routeContext({ id: receipt.id })
      );
      expect(fileResponse.status, filePath).toBe(404);
    }
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
