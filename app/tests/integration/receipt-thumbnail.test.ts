import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import sharp from "sharp";
import { GET as preview } from "@/app/api/receipts/[id]/file/preview/route";
import { prisma } from "@/lib/db";
import { removeUserUpload, writePrivateUpload } from "@/lib/storage";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, routeContext, sessionCookie } from "./helpers/http";

/** List rows downloaded the whole phone photo for a 40 pt thumbnail (median 3,3 s, 2026-10-08). */

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function photo(): Promise<Buffer> {
  const width = 2400, height = 3200;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 2654435761) % 251;
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

describe("GET /api/receipts/[id]/file/preview?size=thumb", () => {
  it("serves a small cached copy, and deleting the upload removes the copies", async () => {
    const original = await photo();
    const { storageKey, absolutePath } = await writePrivateUpload(user.id, ".jpg", original);
    const receipt = await createReceipt(user.id);
    await prisma.receipt.update({ where: { id: receipt.id }, data: { filePath: storageKey, fileName: "kuitti.jpg" } });

    const ask = (query: string) =>
      preview(buildRequest("GET", `/api/receipts/${receipt.id}/file/preview${query}`, undefined, { cookie }), routeContext({ id: receipt.id }));

    const thumb = await ask("?size=thumb");
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    const body = Buffer.from(await thumb.arrayBuffer());
    expect(body.length).toBeLessThan(original.length / 10);
    const meta = await sharp(body).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(360);
    expect(fs.existsSync(`${absolutePath}.360.jpg`)).toBe(true);

    const view = await ask("");
    const viewMeta = await sharp(Buffer.from(await view.arrayBuffer())).metadata();
    expect(Math.max(viewMeta.width!, viewMeta.height!)).toBe(1600);
    expect(fs.existsSync(`${absolutePath}.1600.jpg`)).toBe(true);

    await removeUserUpload(user.id, storageKey);
    expect(fs.existsSync(absolutePath)).toBe(false);
    expect(fs.existsSync(`${absolutePath}.360.jpg`)).toBe(false);
    expect(fs.existsSync(`${absolutePath}.1600.jpg`)).toBe(false);
  });
});
