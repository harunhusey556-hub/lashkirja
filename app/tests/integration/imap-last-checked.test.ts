import { beforeEach, describe, expect, it } from "vitest";
import { GET as getProfile, PATCH as patchProfile } from "@/app/api/profile/route";
import { prisma } from "@/lib/db";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/** Sähköposti shows when the mailbox was last checked, by the server's own runs too. */

let user: TestUser;
let cookie: string;
const checked = new Date("2026-10-02T18:30:00.000Z");

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  await prisma.imapAccount.create({
    data: { userId: user.id, email: "laskut@example.com", encryptedPass: "x", lastCheckedAt: checked },
  });
});

describe("profile imapAccounts", () => {
  it("carries the last check time on GET", async () => {
    const response = await getProfile(buildRequest("GET", "/api/profile", undefined, { cookie }));
    const body = await readJson(response);
    const accounts = (body.profile ?? body).imapAccounts;
    expect(accounts[0].lastCheckedAt).toBe(checked.toISOString());
  });

  it("carries it on PATCH too, so a saved profile keeps it", async () => {
    const response = await patchProfile(buildRequest("PATCH", "/api/profile", { firstName: "Harun" }, { cookie }));
    const body = await readJson(response);
    expect(body.profile.imapAccounts[0].lastCheckedAt).toBe(checked.toISOString());
  });
});

describe("PATCH /api/profile keeps the business profile the app reads (2026-10-09)", () => {
  it("an ALV status, period or company form changed in Settings reaches businessDetails", async () => {
    const { parseBusinessDetails } = await import("@/lib/onboarding");
    const owner = await createUser({ vatRegistered: false });
    await prisma.user.update({ where: { id: owner.id }, data: { businessDetails: null, entityType: "toiminimi" } });
    const ownerCookie = await sessionCookie(owner);
    const response = await patchProfile(
      buildRequest("PATCH", "/api/profile", { vatRegistered: true, vatPeriod: "quarter", entityType: "oy" }, { cookie: ownerCookie })
    );
    expect(response.status).toBe(200);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    const profile = parseBusinessDetails(stored.businessDetails);
    expect([profile.vatRegistered, profile.vatPeriod, profile.entityType]).toEqual([true, "quarter", "oy"]);
  });
});
