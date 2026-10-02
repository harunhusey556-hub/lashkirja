import { beforeEach, describe, expect, it } from "vitest";
import { GET as listReceipts } from "@/app/api/receipts/route";
import { GET as countReceipts } from "@/app/api/receipts/counts/route";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/** Raportit "Ilman ALV-erittelyä" opens Kuitit narrowed to exactly those receipts (?vat=missing). */

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("GET /api/receipts?vat=missing", () => {
  it("lists and counts only receipts without a VAT breakdown", async () => {
    const none = await createReceipt(user.id, { vatDetails: null, date: "2026-03-01" });
    const empty = await createReceipt(user.id, { vatDetails: "[]", date: "2026-03-02" });
    await createReceipt(user.id, { vatDetails: JSON.stringify([{ rate: 25.5, amount: 2.4 }]), date: "2026-03-03" });

    const list = await readJson<Json>(await listReceipts(buildRequest("GET", "/api/receipts?month=2026&vat=missing", undefined, { cookie })));
    expect(list.receipts.map((r: Json) => r.id).sort()).toEqual([none.id, empty.id].sort());

    const counts = await readJson<Json>(await countReceipts(buildRequest("GET", "/api/receipts/counts?month=2026&vat=missing", undefined, { cookie })));
    expect(counts.counts.all).toBe(2);
  });

  it("is ignored for any other value", async () => {
    await createReceipt(user.id, { vatDetails: null, date: "2026-03-01" });
    await createReceipt(user.id, { vatDetails: JSON.stringify([{ rate: 25.5, amount: 2.4 }]), date: "2026-03-03" });
    const list = await readJson<Json>(await listReceipts(buildRequest("GET", "/api/receipts?month=2026&vat=x", undefined, { cookie })));
    expect(list.receipts).toHaveLength(2);
  });
});
