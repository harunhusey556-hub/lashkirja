/**
 * Wave 3, lane F2 (F64): server validation answers in Finnish, names the field
 * and the limit, and a body that is not JSON is a 400, not a 500.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as createCustomer } from "@/app/api/customers/route";
import { PATCH as patchProfile } from "@/app/api/profile/route";
import { PATCH as patchReceipt } from "@/app/api/receipts/[id]/route";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

describe("F64 validation answers", () => {
  it("a too long receipt field is refused with the field and the limit in Finnish", async () => {
    const receipt = await createReceipt(user.id, { reviewStatus: "pending" });
    const response = await patchReceipt(
      buildRequest("PATCH", `/api/receipts/${receipt.id}`, { vendor: "x".repeat(400) }, { cookie }),
      routeContext({ id: receipt.id })
    );
    expect(response.status).toBe(400);
    const body = await readJson(response);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.message).toBe("Tarkista lomakkeen tiedot");
    expect(body.error.details).toEqual([
      { path: "vendor", field: "vendor", message: "Myyjä saa olla enintään 300 merkkiä" },
    ]);
  });

  it("a body that is not JSON is a 400 with a Finnish message", async () => {
    const request = new NextRequest(new URL("/api/customers", "http://localhost:3000"), {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "content-length": "5" },
      body: "{not{",
    });
    const response = await createCustomer(request);
    expect(response.status).toBe(400);
    const body = await readJson(response);
    expect(body.error.message).toMatch(/ei voitu lukea/);
  });

  it("a too long seller value names the field and the limit (F14)", async () => {
    const response = await patchProfile(
      buildRequest("PATCH", "/api/profile", { businessName: "x".repeat(130), phone: "1".repeat(50) }, { cookie })
    );
    expect(response.status).toBe(400);
    const body = await readJson(response);
    expect(body.error).toBe("Toiminimi saa olla enintään 120 merkkiä");
    expect(body.field).toBe("businessName");
    expect(body.details.map((issue: { field: string }) => issue.field)).toEqual(["businessName", "phone"]);
  });
});
