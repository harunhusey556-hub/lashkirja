/**
 * The Unicode font the PDFs are drawn with.
 *
 * pdfkit's built-in Helvetica only covers WinAnsi, so a customer called
 * "Şükrü Ağaoğlu" or "Łukasz" came out as garbage. Liberation Sans (SIL OFL,
 * metric-compatible with Helvetica/Arial) covers Latin, Latin Extended,
 * Greek and Cyrillic. The files ship in app/assets/fonts; pdfjs-dist already
 * carries the same two files, so that is the fallback. When neither is found
 * (a deployment that copied neither) the PDF falls back to Helvetica and the
 * text sanitiser, which is slower to read but never garbled.
 */
import fs from "node:fs";
import path from "node:path";

export interface PdfFontFiles {
  regular: string;
  bold: string;
}

const REGULAR = "LiberationSans-Regular.ttf";
const BOLD = "LiberationSans-Bold.ttf";

function candidateDirs(): string[] {
  const cwd = process.cwd();
  return [
    path.join(cwd, "assets", "fonts"),
    path.join(cwd, "app", "assets", "fonts"),
    path.join(cwd, "node_modules", "pdfjs-dist", "standard_fonts"),
    path.join(cwd, "app", "node_modules", "pdfjs-dist", "standard_fonts"),
  ];
}

let cached: PdfFontFiles | null | undefined;

export function pdfFontFiles(): PdfFontFiles | null {
  if (cached !== undefined) return cached;
  cached = null;
  for (const dir of candidateDirs()) {
    const regular = path.join(dir, REGULAR);
    const bold = path.join(dir, BOLD);
    if (fs.existsSync(regular) && fs.existsSync(bold)) {
      cached = { regular, bold };
      break;
    }
  }
  return cached;
}

/** For tests: forget the cached lookup. */
export function resetPdfFontCache(): void {
  cached = undefined;
}
