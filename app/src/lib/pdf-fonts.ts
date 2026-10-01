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

/**
 * Where the fonts may live. The lookup must not depend on the process cwd:
 * in production run-prod.ps1 starts web and worker with cwd C:\LashKirja while
 * the checkout is C:\LashKirja\prod\app, so cwd-relative paths miss it.
 * Order: LASHKIRJA_APP_DIR (set by run-prod.ps1), the module's own location
 * (app/src/lib -> app), then cwd-relative guesses.
 */
function candidateDirs(): string[] {
  const roots: string[] = [];
  const envDir = process.env.LASHKIRJA_APP_DIR;
  if (envDir) roots.push(envDir);
  if (typeof __dirname === "string") {
    roots.push(path.resolve(__dirname, "..", ".."));
  }
  const cwd = process.cwd();
  roots.push(cwd, path.join(cwd, "app"), path.join(cwd, "prod", "app"));
  const dirs: string[] = [];
  for (const root of roots) {
    dirs.push(path.join(root, "assets", "fonts"));
    dirs.push(path.join(root, "node_modules", "pdfjs-dist", "standard_fonts"));
  }
  return dirs;
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
  if (!cached) {
    console.warn(
      "[pdf] Liberation Sans fonts not found; PDFs fall back to Helvetica (set LASHKIRJA_APP_DIR to the app folder)",
    );
  }
  return cached;
}

/** For tests: forget the cached lookup. */
export function resetPdfFontCache(): void {
  cached = undefined;
}
