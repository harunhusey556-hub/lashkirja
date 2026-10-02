import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractReceipt } from "./ai";

/** A receipt photo goes to the model as an image: no local OCR (tesseract) is needed for it. */

let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-"));
  process.env.CLOUD_AI_ENABLED = "true";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_BASE_URL = "https://llm.example/v1";
  process.env.LLM_MODEL = "vision-model";
  delete process.env.COPILOT_GITHUB_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...saved };
  fs.rmSync(dir, { recursive: true, force: true });
});

async function photo(width = 3000, height = 4000): Promise<string> {
  const file = path.join(dir, "kuitti.png");
  await sharp({ create: { width, height, channels: 3, background: "#ffffff" } }).png().toFile(file);
  return file;
}

function answer(json: object) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(json) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("receipt photo extraction", () => {
  it("sends the photo to the model and reads its answer", async () => {
    const fetchMock = vi.fn(async () =>
      answer({ vendor: "K-Market", date: "2026-10-01", totalAmount: 8.9, vatDetails: [{ rate: 13.5, amount: 1.06 }], category: "tarvikkeet", type: "meno", documentType: "kuitti" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractReceipt(await photo(), "image/png");

    expect(result.vendor).toBe("K-Market");
    expect(result.totalAmount).toBe(8.9);
    expect(result.documentType).toBe("receipt");
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body));
    const parts = body.messages[0].content as Array<{ type: string; image_url?: { url: string } }>;
    const image = parts.find((part) => part.type === "image_url");
    expect(image?.image_url?.url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(body.model).toBe("vision-model");
  });

  it("shrinks a large photo before sending it", async () => {
    const fetchMock = vi.fn(async () => answer({ vendor: "S-Market", totalAmount: 3, type: "meno", documentType: "kuitti" }));
    vi.stubGlobal("fetch", fetchMock);

    await extractReceipt(await photo(4000, 6000), "image/png");

    const body = JSON.parse(String(((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body));
    const url: string = body.messages[0].content.find((part: { type: string }) => part.type === "image_url").image_url.url;
    const meta = await sharp(Buffer.from(url.split(",")[1], "base64")).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2000);
  });
});
