import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pdfFontFiles, resetPdfFontCache } from "./pdf-fonts";

const realCwd = process.cwd();

afterEach(() => {
  process.chdir(realCwd);
  delete process.env.LASHKIRJA_APP_DIR;
  resetPdfFontCache();
  vi.restoreAllMocks();
});

describe("pdfFontFiles", () => {
  it("finds the bundled fonts when the cwd is an unrelated folder (production layout)", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "lk-fonts-"));
    process.chdir(elsewhere);
    resetPdfFontCache();
    const found = pdfFontFiles();
    expect(found).not.toBeNull();
    expect(fs.existsSync(found!.regular)).toBe(true);
    expect(fs.existsSync(found!.bold)).toBe(true);
  });

  it("uses LASHKIRJA_APP_DIR first", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lk-fonts-env-"));
    const dir = path.join(root, "assets", "fonts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "LiberationSans-Regular.ttf"), "x");
    fs.writeFileSync(path.join(dir, "LiberationSans-Bold.ttf"), "x");
    process.env.LASHKIRJA_APP_DIR = root;
    resetPdfFontCache();
    expect(pdfFontFiles()!.regular).toBe(path.join(dir, "LiberationSans-Regular.ttf"));
  });

  it("finds the production layout under cwd/prod/app", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lk-fonts-prod-"));
    const dir = path.join(root, "prod", "app", "assets", "fonts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "LiberationSans-Regular.ttf"), "x");
    fs.writeFileSync(path.join(dir, "LiberationSans-Bold.ttf"), "x");
    process.chdir(root);
    resetPdfFontCache();
    expect(pdfFontFiles()).not.toBeNull();
  });
});
