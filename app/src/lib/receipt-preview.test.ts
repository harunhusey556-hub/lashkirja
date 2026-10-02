import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { receiptPreview } from "./receipt-preview";

async function photo(width: number, height: number): Promise<Buffer> {
  // Noise compresses badly, like a real photo, so the original is several hundred KB.
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 2654435761) % 251;
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

describe("receipt previews", () => {
  it("sends a large photo as a 1600 px JPEG", async () => {
    const original = await photo(3000, 4000);
    const preview = await receiptPreview(original, "image/jpeg");
    expect(preview).not.toBeNull();
    expect(preview!.contentType).toBe("image/jpeg");
    expect(preview!.body.length).toBeLessThan(original.length);
    const meta = await sharp(preview!.body).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(1600);
  });

  it("leaves small images, PDFs and unknown files alone", async () => {
    expect(await receiptPreview(await photo(300, 200), "image/jpeg")).toBeNull();
    expect(await receiptPreview(Buffer.from("%PDF-1.4"), "application/pdf")).toBeNull();
    expect(await receiptPreview(Buffer.alloc(2_000_000), "image/jpeg")).toBeNull();
  });
});
