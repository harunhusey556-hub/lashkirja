import { beforeEach, describe, expect, it } from "vitest";
import { PATCH as patchProfile } from "@/app/api/profile/route";
import { prisma } from "@/lib/db";
import { ENTITY_TYPES } from "@/lib/onboarding";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  await prisma.user.update({
    where: { id: user.id },
    data: { reminderFeeCents: 500, lateInterestPercent: 7 },
  });
});

describe("profile save", () => {
  it("accepts the same company types as onboarding, including Oy", async () => {
    const response = await patchProfile(
      buildRequest("PATCH", "/api/profile", { entityType: "oy" }, { cookie })
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.profile.entityType).toBe("oy");
    expect(ENTITY_TYPES).toContain("oy");

    const rejected = await patchProfile(
      buildRequest("PATCH", "/api/profile", { entityType: "osuuskunta" }, { cookie })
    );
    expect(rejected.status).toBe(400);
  });

  it("does not write reminder settings when a later field fails validation", async () => {
    const response = await patchProfile(
      buildRequest(
        "PATCH",
        "/api/profile",
        { reminderFee: 12, invoiceIban: "FI2112345600000786" },
        { cookie }
      )
    );
    expect(response.status).toBe(400);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { reminderFeeCents: true, invoiceIban: true, lateInterestPercent: true },
    });
    expect(stored.reminderFeeCents).toBe(500);
    expect(stored.invoiceIban).toBeNull();
    expect(stored.lateInterestPercent).toBe(7);
  });

  it("trims the names, caps them and answers a blank name in plain Finnish (F63)", async () => {
    const trimmed = await patchProfile(
      buildRequest("PATCH", "/api/profile", { firstName: "  Anna  ", lastName: " Virtanen " }, { cookie })
    );
    expect(trimmed.status).toBe(200);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { firstName: true, lastName: true },
    });
    expect(stored).toEqual({ firstName: "Anna", lastName: "Virtanen" });

    const blank = await patchProfile(
      buildRequest("PATCH", "/api/profile", { firstName: "   " }, { cookie })
    );
    expect(blank.status).toBe(400);
    expect((await readJson(blank)).error).toBe("Anna etunimi.");
    const blankLast = await patchProfile(
      buildRequest("PATCH", "/api/profile", { lastName: "" }, { cookie })
    );
    expect(blankLast.status).toBe(400);
    expect((await readJson(blankLast)).error).toBe("Anna sukunimi.");

    const long = await patchProfile(
      buildRequest("PATCH", "/api/profile", { firstName: "F".repeat(5000) }, { cookie })
    );
    expect(long.status).toBe(400);
    expect((await readJson(long)).error).toBe("Etunimi saa olla enintään 120 merkkiä.");
    const longLast = await patchProfile(
      buildRequest("PATCH", "/api/profile", { lastName: "L".repeat(300) }, { cookie })
    );
    expect(longLast.status).toBe(400);
    expect((await readJson(longLast)).error).toBe("Sukunimi saa olla enintään 120 merkkiä.");
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { firstName: true, lastName: true },
    });
    expect(after).toEqual({ firstName: "Anna", lastName: "Virtanen" });
  });

  it("writes reminder settings and seller details in one update", async () => {
    const response = await patchProfile(
      buildRequest(
        "PATCH",
        "/api/profile",
        {
          reminderFee: 9,
          lateInterestPercent: 8.5,
          invoiceIban: "FI21 1234 5600 0007 85",
          businessId: "0201256-6",
          entityType: "oy",
        },
        { cookie }
      )
    );
    expect(response.status).toBe(200);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        reminderFeeCents: true,
        lateInterestPercent: true,
        invoiceIban: true,
        businessId: true,
        entityType: true,
      },
    });
    expect(stored).toMatchObject({
      reminderFeeCents: 900,
      lateInterestPercent: 8.5,
      invoiceIban: "FI2112345600000785",
      businessId: "0201256-6",
      entityType: "oy",
    });
  });
});
