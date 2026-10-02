import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  categoriesForAiPrompt,
  normalizeExtractedCategory,
  RECEIPT_CATEGORY_IDS,
} from "./receipt-categories";
import {
  categoriesVatHintsForAiPrompt,
  guessVatForReceipt,
} from "./vat-rules";
import { amountsOnLine, isoFromDateMatch, DATE_RE, parseAmount } from "./finnish-numbers";

import { getTopVendorsForAiPrompt } from "./vendor-intelligence";

export interface ExtractedReceipt {
  vendor: string | null;
  date: string | null;
  totalAmount: number | null;
  vatDetails: { rate: number; amount: number }[];
  category: string | null;
  notes: string | null;
  type: "tulo" | "meno";
  reference: string | null;
  invoiceNumber: string | null;
  source: "ai" | "ocr";
  provenance: "local-ocr" | "openai-compatible" | "github-copilot";
  confidence: number;
  rawText?: string;
  /** Nothing could be read from the file: the form opens empty for manual entry (F04). */
  unreadable?: boolean;
  /** What the AI took the document to be; mail sync archives marketing and other non-bills. */
  documentType?: DocumentType | null;
}

export type DocumentType = "receipt" | "invoice" | "marketing" | "other";

const DOCUMENT_TYPES: Record<string, DocumentType> = {
  kuitti: "receipt", receipt: "receipt", tilausvahvistus: "receipt",
  lasku: "invoice", invoice: "invoice",
  markkinointi: "marketing", marketing: "marketing", mainos: "marketing", uutiskirje: "marketing",
  muu: "other", other: "other",
};

function normalizeDocumentType(value: unknown): DocumentType | null {
  if (typeof value !== "string") return null;
  return DOCUMENT_TYPES[value.trim().toLocaleLowerCase("fi-FI")] ?? null;
}

export class ReceiptExtractionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReceiptExtractionError";
    this.code = code;
  }
}

/** No text could be read (no OCR on the machine, or an image with nothing to read): not a broken file. */
export function isUnreadableDocumentError(error: unknown): boolean {
  return (
    error instanceof ReceiptExtractionError &&
    (error.code === "NO_TEXT" || error.code === "PDF_OCR_FAILED")
  );
}

/** The extraction of a file nothing could be read from: every field empty, to be typed in by hand. */
export function unreadableExtraction(): ExtractedReceipt {
  return {
    vendor: null,
    date: null,
    totalAmount: null,
    vatDetails: [],
    category: null,
    notes: null,
    type: "meno",
    reference: null,
    invoiceNumber: null,
    source: "ocr",
    provenance: "local-ocr",
    confidence: 0,
    unreadable: true,
  };
}

const MAX_RECEIPT_BYTES = 20 * 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 12 * 1024 * 1024;
const CLOUD_TIMEOUT_MS = 30_000;
const MAX_LLM_TEXT_CHARS = 80_000;

const CATEGORIES = [...RECEIPT_CATEGORY_IDS];

function buildExtractionPrompt(profileContext: string | null, vendorPriors: string): string {
  const profileHint = profileContext ? `\nKäyttäjän yritysprofiili:\n${profileContext}\n` : "";
  const priorsHint = vendorPriors ? `\n${vendorPriors}\n` : "";
  
  return `Olet kirjanpidon avustaja. Analysoi tämä kuitti/lasku ja palauta tiedot JSON-muodossa.
${profileHint}
Palauta VAIN validi JSON seuraavalla rakenteella (ei muuta tekstiä):
{
  "vendor": "myyjän nimi",
  "date": "YYYY-MM-DD",
  "totalAmount": 123.45,
  "vatDetails": [{"rate": 25.5, "amount": 12.34}],
  "category": "tarvikkeet",
  "notes": "valinnainen selite jos kategoria epävarma tai tarvitaan lisätieto",
  "type": "meno",
  "reference": "maksun viitenumero (esim. 1009 tai RF-viite), EI viitteenne/viitteemme",
  "invoiceNumber": "laskun numero",
  "documentType": "kuitti"
}

documentType: "kuitti" (ostokuitti tai maksukuitti), "lasku" (maksettava lasku), "markkinointi" (mainos, tarjous, uutiskirje, kampanja — vaikka siinä näkyisi hintoja) tai "muu" (esim. toimitusilmoitus, tiedote, salasanaviesti). Vain kuitti ja lasku kirjataan kirjanpitoon.

Kategoriat (käytä TARKALLEEN näitä id-arvoja category-kentässä):
${categoriesForAiPrompt()}${priorsHint}
Jos mikään kategoria ei sovi, käytä "muut" ja selitä lyhyesti notes-kentässä.
ALV-säännöt (2026):
- Jos laskussa/kuitissa on ALV-erittely, käytä sitä vatDetails-kentässä.
- Jos ALV puuttuu, arvioi kategorian perusteella:
${categoriesVatHintsForAiPrompt()}
- Vakuutus, TyEL/YEL, pankkipalvelumaksut, verot: vatDetails [{rate:0, amount:0}], ei vähennyskelpoista ALV:ta.
- Muistutusmaksu/viivästyskorko/perintämaksu (5–10 € yms.) EI ole ALV-vähennyskelpoinen — kirjoita notes-kenttään, älä sisällytä ALV-laskentaan.
- Oletus verollisille ostoille: 25,5 % ellei 13,5 % tai 10 % ole selvästi oikea.
Tyyppi: "tulo" (myynti/tulo) tai "meno" (osto/kulu)
ALV-kannat Suomessa 2026: 25.5%, 13.5%, 10%, 0%
Päivämäärä muodossa YYYY-MM-DD.
Summat desimaalilukuina (piste erottimena).
Jos tietoa ei löydy, käytä null. ÄLÄ KOSKAAN arvaa tai keksi arvoja — erityisesti päivämäärää: jos sitä ei näy dokumentissa, palauta null.`;
}

function isCloudAiEnabled(): boolean {
  const flag = (process.env.CLOUD_AI_ENABLED || "").toLocaleLowerCase("en-US");
  if (flag === "true") return true;
  if (flag === "false") return false;
  return Boolean(process.env.LLM_API_KEY || process.env.COPILOT_GITHUB_TOKEN);
}

export async function extractReceipt(
  filePath: string,
  mimeType: string,
  profileContext?: string,
  vendorPriors?: string
): Promise<ExtractedReceipt> {
  mimeType = detectReceiptMime(filePath, mimeType);
  const converted = await convertHeicIfNeeded(filePath, mimeType);
  filePath = converted.filePath;
  mimeType = converted.mimeType;

  try {
    // A photo is read by the model from the image itself; local OCR is only the fallback.
    if (isCloudAiEnabled() && process.env.LLM_API_KEY && mimeType.startsWith("image/")) {
      try {
        const result = await extractWithAIFromImage(filePath, process.env.LLM_API_KEY, profileContext, vendorPriors);
        return enrichExtractedReceipt({ ...result, rawText: "" });
      } catch (error) {
        console.warn("Receipt photo extraction failed; trying OCR:", error instanceof Error ? error.message : "UnknownError");
      }
    }

    const rawText = await extractDocumentText(filePath, mimeType);

    if (isCloudAiEnabled()) {
      const apiKey = process.env.LLM_API_KEY;
      const copilotToken = process.env.COPILOT_GITHUB_TOKEN;
      const isPdf = mimeType === "application/pdf";

      const tryLLM = apiKey
        ? () => extractWithAIFromText(rawText, apiKey, profileContext, vendorPriors)
        : null;
      // A Copilot quota refusal pauses it (copilot.ts): the next path is tried directly.
      const tryCopilot =
        copilotToken && !copilotPaused()
          ? () =>
              extractWithCopilotFromText(rawText, copilotToken, profileContext, vendorPriors).catch((error: unknown) => {
                noteCopilotFailure(error);
                throw error;
              })
          : null;
      const attempts = (isPdf ? [tryCopilot, tryLLM] : [tryLLM, tryCopilot]).filter(
        (fn): fn is () => Promise<ExtractedReceipt> => fn !== null
      );

      for (const attempt of attempts) {
        try {
          const result = await attempt();
          return enrichExtractedReceipt({ ...result, rawText });
        } catch (error) {
          console.warn(
            "Cloud receipt extraction failed; trying the next configured path:",
            error instanceof Error ? error.message : "UnknownError"
          );
        }
      }
    }

    return parseOCRText(rawText);
  } finally {
    if (converted.temporaryPath && fs.existsSync(converted.temporaryPath)) {
      fs.unlinkSync(converted.temporaryPath);
    }
  }
}

function detectReceiptMime(filePath: string, claimedMime: string): string {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) {
    throw new ReceiptExtractionError("EMPTY_FILE", "Kuittitiedosto on tyhjä");
  }
  if (stat.size > MAX_RECEIPT_BYTES) {
    throw new ReceiptExtractionError(
      "FILE_TOO_LARGE",
      `Kuittitiedosto on liian suuri (enintään ${MAX_RECEIPT_BYTES / 1024 / 1024} Mt)`
    );
  }
  const fd = fs.openSync(filePath, "r");
  const header = Buffer.alloc(32);
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  const brand = header.subarray(4, 16).toString("ascii");
  if (/ftyp(?:heic|heix|hevc|hevx|heim|heis|mif1|msf1)/i.test(brand)) {
    return "image/heic";
  }
  
  const textHead = header.toString("utf8").trimStart().toLowerCase();
  if (textHead.startsWith("<html") || textHead.startsWith("<!doc") || claimedMime === "text/html") {
    return "text/html";
  }

  throw new ReceiptExtractionError(
    "UNSUPPORTED_FILE",
    `Tiedoston sisältö ei vastaa tuettua PDF-, JPG-, PNG-, HEIC- tai HTML-muotoa (${claimedMime || "tuntematon"})`
  );
}

import {
  getCopilotSessionToken,
  COPILOT_HEADERS,
  copilotPaused,
  fetchWithTimeout,
  noteCopilotFailure,
  ProviderHttpError,
} from "./copilot";

function boundedLLMText(text: string): string {
  const cleaned = text.replace(/\0/g, "");
  if (cleaned.length <= MAX_LLM_TEXT_CHARS) return cleaned;
  const half = Math.floor(MAX_LLM_TEXT_CHARS / 2);
  return `${cleaned.slice(0, half)}\n\n[... dokumentin keskiosa rajattu ...]\n\n${cleaned.slice(-half)}`;
}

async function extractWithCopilotFromText(
  docText: string,
  ghToken: string,
  profileContext?: string,
  vendorPriors?: string
): Promise<ExtractedReceipt> {
  if (docText.trim().length < 20) {
    throw new Error("Too little text extracted for LLM analysis");
  }

  const model = process.env.COPILOT_MODEL || "gpt-4o";
  const session = await getCopilotSessionToken(ghToken);
  const bounded = boundedLLMText(docText);
  
  const promptText = buildExtractionPrompt(profileContext || null, vendorPriors || "");

  const content = [
    { type: "text", text: promptText },
    { type: "text", text: `Kuitin/laskun teksti:\n${bounded}` },
  ];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.token}`,
    "Copilot-Integration-Id": "vscode-chat",
    "Openai-Organization": "github-copilot",
    ...COPILOT_HEADERS,
  };

  const response = await fetchWithTimeout(
    `${session.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        max_tokens: 1000,
        temperature: 0.1,
      }),
    }
  );

  if (!response.ok) {
    throw new ProviderHttpError(`Copilot API error: ${response.status}`, response.status);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Copilot response");

  return normalizeAIResult(JSON.parse(jsonMatch[0]), "github-copilot");
}

async function extractWithCopilot(
  filePath: string,
  mimeType: string,
  ghToken: string
): Promise<ExtractedReceipt> {
  const docText = await extractDocumentText(filePath, mimeType);
  return extractWithCopilotFromText(docText, ghToken);
}

async function convertHeicIfNeeded(
  filePath: string,
  mimeType: string
): Promise<{ filePath: string; mimeType: string; temporaryPath?: string }> {
  const isHeic =
    /heic|heif/i.test(mimeType) || /\.(heic|heif)$/i.test(filePath);
  if (!isHeic) return { filePath, mimeType };

  const heicConvert = (await import("heic-convert")).default;
  const inputBuffer = fs.readFileSync(filePath);
  const outputBuffer = await heicConvert({
    buffer: inputBuffer,
    format: "JPEG",
    quality: 0.9,
  });
  const jpegPath = `${filePath}.converted.jpg`;
  fs.writeFileSync(jpegPath, Buffer.from(outputBuffer), { mode: 0o600 });
  return { filePath: jpegPath, mimeType: "image/jpeg", temporaryPath: jpegPath };
}

async function extractWithAIFromText(
  docText: string,
  apiKey: string,
  profileContext?: string,
  vendorPriors?: string
): Promise<ExtractedReceipt> {
  if (docText.trim().length < 20) {
    throw new Error("Too little text extracted for LLM analysis");
  }

  const baseUrl = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  
  const promptText = buildExtractionPrompt(profileContext || null, vendorPriors || "");
    
  const content = `${promptText}\n\nKuitin/laskun teksti:\n${boundedLLMText(docText)}`;
  return postExtraction(baseUrl, model, apiKey, content);
}

/** Longest side of a photo sent to the model: enough to read a till slip, small to send. */
const VISION_MAX_SIDE = 1600;

/**
 * A photo goes to the model as an image (OpenAI-compatible `image_url`, which Gemini accepts),
 * so reading it needs no local OCR: before this, a photo without tesseract on the server was
 * saved with every field empty. Turned upright by its EXIF, scaled down and sent as JPEG.
 */
async function extractWithAIFromImage(
  filePath: string,
  apiKey: string,
  profileContext?: string,
  vendorPriors?: string
): Promise<ExtractedReceipt> {
  const sharp = (await import("sharp")).default;
  const jpeg = await sharp(fs.readFileSync(filePath), { failOn: "none" })
    .rotate()
    .resize({ width: VISION_MAX_SIDE, height: VISION_MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  const baseUrl = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  const promptText = buildExtractionPrompt(profileContext || null, vendorPriors || "");
  return postExtraction(baseUrl, model, apiKey, [
    { type: "text", text: `${promptText}\n\nKuitti tai lasku on liitteenä kuvana.` },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
  ]);
}

type ExtractionContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

async function postExtraction(baseUrl: string, model: string, apiKey: string, content: ExtractionContent): Promise<ExtractedReceipt> {
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      max_tokens: 1000,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const txt = await response.text();
    console.error(`AI API error HTTP ${response.status}:`, txt.slice(0, 500));
    throw new Error(`AI API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error("No JSON in AI response. Text was:", text.slice(0, 500));
    throw new Error("No JSON in AI response");
  }

  return normalizeAIResult(JSON.parse(jsonMatch[0]), "openai-compatible");
}

async function extractWithAI(
  filePath: string,
  mimeType: string,
  apiKey: string
): Promise<ExtractedReceipt> {
  const docText = await extractDocumentText(filePath, mimeType);
  return extractWithAIFromText(docText, apiKey);
}

/** Whole cents: /api/receipts/save refuses an amount with more than two decimals. */
function toCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function normalizeAIResult(
  value: unknown,
  provenance: "openai-compatible" | "github-copilot"
): ExtractedReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReceiptExtractionError("INVALID_AI_RESPONSE", "AI palautti virheellisen vastauksen");
  }
  const parsed = value as Record<string, unknown>;
  const vendor =
    typeof parsed.vendor === "string" && parsed.vendor.trim().length <= 300
      ? parsed.vendor.trim() || null
      : null;
  const date =
    typeof parsed.date === "string" && isStrictIsoDate(parsed.date)
      ? parsed.date
      : null;
  const total = Number(parsed.totalAmount);
  const totalAmount = Number.isFinite(total) && total >= 0 ? toCents(total) : null;
  const allowedRates = new Set([0, 10, 13.5, 14, 24, 25.5]);
  const vatDetails = (Array.isArray(parsed.vatDetails) ? parsed.vatDetails : [])
    .map((line) => {
      if (!line || typeof line !== "object") return null;
      const rate = Number((line as Record<string, unknown>).rate);
      const amount = Number((line as Record<string, unknown>).amount);
      if (!allowedRates.has(rate) || !Number.isFinite(amount) || amount < 0) return null;
      return { rate, amount: toCents(amount) };
    })
    .filter((line): line is { rate: number; amount: number } => line !== null);
  return {
    vendor,
    date,
    totalAmount,
    vatDetails,
    category: normalizeExtractedCategory(parsed.category),
    notes: normalizeExtractedNotes(parsed.notes),
    type: parsed.type === "tulo" ? "tulo" : "meno",
    reference: normalizeExtractedRef(parsed.reference),
    invoiceNumber: normalizeExtractedRef(parsed.invoiceNumber),
    source: "ai",
    provenance,
    confidence: 0.85,
    documentType: normalizeDocumentType(parsed.documentType),
  };
}

function isStrictIsoDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

async function extractPDFText(filePath: string): Promise<string> {
  try {
    return execFileSync("pdftotext", ["-layout", filePath, "-"], {
      timeout: 30_000,
      maxBuffer: MAX_TOOL_OUTPUT_BYTES,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    try {
      const { PDFParse } = await import("pdf-parse");
      const buffer = fs.readFileSync(filePath);
      const parser = new PDFParse({ data: buffer });
      try {
        return (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    } catch (error) {
      throw new ReceiptExtractionError(
        "PDF_TEXT_EXTRACTION_FAILED",
        `PDF:n tekstin luku epäonnistui: ${error instanceof Error ? error.message : "tuntematon virhe"}`
      );
    }
  }
}

async function extractDocumentText(
  filePath: string,
  mimeType: string
): Promise<string> {
  let rawText = "";

  if (mimeType === "application/pdf") {
    try {
      rawText = await extractPDFText(filePath);
    } catch {
      rawText = "";
    }
    if (rawText.trim().length < 10) {
      try {
        rawText = ocrScannedPdfReceipt(filePath);
      } catch (error) {
        if (rawText.trim().length < 10) {
          throw new ReceiptExtractionError(
            "NO_TEXT",
            error instanceof ReceiptExtractionError
              ? error.message
              : "Kuvaa ei voitu lukea. Kokeile terävämpää kuvaa tai tekstipohjaista PDF:ää."
          );
        }
      }
    }
  } else if (mimeType === "text/html") {
    const rawHtml = fs.readFileSync(filePath, "utf8");
    rawText = rawHtml
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } else {
    try {
      rawText = execFileSync(
        "tesseract",
        [filePath, "stdout", "-l", "fin+swe+eng"],
        {
          timeout: 30_000,
          maxBuffer: MAX_TOOL_OUTPUT_BYTES,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }
      );
    } catch {
      rawText = "";
    }
  }

  if (rawText.trim().length < 10) {
    throw new ReceiptExtractionError(
      "NO_TEXT",
      "Kuvaa ei voitu lukea. Kokeile terävämpää kuvaa tai tekstipohjaista PDF:ää."
    );
  }
  return rawText;
}

async function extractWithOCR(
  filePath: string,
  mimeType: string
): Promise<ExtractedReceipt> {
  const rawText = await extractDocumentText(filePath, mimeType);
  return parseOCRText(rawText);
}

/** OCR for image-only PDF receipts (typically 1–3 pages). */
function ocrScannedPdfReceipt(filePath: string): string {
  const tempRoot = path.resolve(os.tmpdir());
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "lashkirja-receipt-"));
  const resolvedTempDir = path.resolve(tempDir);
  if (
    resolvedTempDir === tempRoot ||
    !resolvedTempDir.startsWith(`${tempRoot}${path.sep}lashkirja-receipt-`)
  ) {
    throw new ReceiptExtractionError(
      "PDF_OCR_FAILED",
      "PDF:n käsittely epäonnistui (väliaikaishakemisto)"
    );
  }
  try {
    const prefix = path.join(resolvedTempDir, "page");
    execFileSync(
      "pdftoppm",
      ["-f", "1", "-l", "3", "-r", "200", "-jpeg", "-jpegopt", "quality=85", filePath, prefix],
      {
        timeout: 45_000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const images = fs
      .readdirSync(resolvedTempDir)
      .filter((name) => /^page-\d+\.jpg$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (images.length === 0) {
      throw new ReceiptExtractionError(
        "PDF_OCR_FAILED",
        "Skannatusta PDF:stä ei saatu sivuja luettua"
      );
    }
    let text = "";
    for (const image of images) {
      const imagePath = path.join(resolvedTempDir, image);
      const imageStat = fs.statSync(imagePath);
      if (!imageStat.isFile() || imageStat.size > 15 * 1024 * 1024) continue;
      text += execFileSync(
        "tesseract",
        [imagePath, "stdout", "-l", "fin+swe+eng", "--psm", "6"],
        {
          timeout: 25_000,
          maxBuffer: MAX_TOOL_OUTPUT_BYTES,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }
      );
      text += "\n";
    }
    return text;
  } catch (error) {
    if (error instanceof ReceiptExtractionError) throw error;
    throw new ReceiptExtractionError(
      "PDF_OCR_FAILED",
      `Skannatun PDF:n OCR epäonnistui: ${error instanceof Error ? error.message : "tuntematon virhe"}`
    );
  } finally {
    fs.rmSync(resolvedTempDir, { recursive: true, force: false });
  }
}

function normalizeExtractedNotes(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 500) return s.slice(0, 500) || null;
  return s;
}

function guessCategory(vendor: string | null, text: string): string | null {
  const hay = `${vendor ?? ""} ${text}`.toLowerCase();
  if (/\b(yel-vakuutus|työeläke|tyoelake|vakuutusmaksu|varma|elo)\b/.test(hay)) {
    return "työeläke";
  }
  if (/\b(työllisyysrahasto|tyollisyysrahasto)\b/.test(hay)) {
    return "työllisyysrahasto";
  }
  if (/\b(verohallinto|ennakkomaksu|vero\b)/.test(hay)) return "verot";
  if (/\b(helsingin kaupunki|kunnallisvero)\b/.test(hay)) return "kuntavero";
  if (/\b(holvi|pankki|palvelumaksu|tilimaksu)\b/.test(hay)) return "pankki";
  if (/\b(fennia|pohjola|vakuutusyhtiö|vakuutus)\b/.test(hay)) return "vakuutus";
  if (/\b(cloudflare|github|jetbrains|merit|saas|software)\b/.test(hay)) {
    return "ohjelmistot";
  }
  if (/\b(helen|sähkö|sahko)\b/.test(hay)) return "sähkö";
  if (/\b(vesi|jätevesi|jatevesi)\b/.test(hay)) return "vesi";
  if (/\b(neste|abc|st1|polttoaine|tankkaus)\b/.test(hay)) return "polttoaine";
  if (/\b(posti|dhl|rahti|kuljetus|uuva)\b/.test(hay)) return "rahti";
  if (/\b(qred|laina|rahoitus)\b/.test(hay)) return "rahoitus";
  if (/\b(elisa|dna|telia|moi|mobile|tele|kuitu)\b/.test(hay)) {
    return "puhelin/netti";
  }
  if (/\b(vuokra|asunto|toimisto|rent|finnvacum)\b/.test(hay)) return "vuokra";
  if (/\b(mainos|markkinointi|google ads|meta ads|facebook)\b/.test(hay)) {
    return "markkinointi";
  }
  if (/\b(taksi|uber|vr\b|finnair|hotelli|matka|lento)\b/.test(hay)) return "matkakulut";
  if (/\b(koulutus|kurssi|webinar|training)\b/.test(hay)) return "koulutus";
  if (
    /\b(s-market|k-market|prisma|lidl|tarvike|bauhaus|k-rauta|gigantti|power|ikea)\b/.test(
      hay
    )
  ) {
    return "tarvikkeet";
  }
  return null;
}

// LLMs sometimes echo the prompt hint back; keep only plausible id-like values.
function normalizeExtractedRef(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 40) return null;
  if (!/\d/.test(s)) return null;
  return s;
}

// --- Viitenumero / laskun numero from raw text (used by OCR path and backfill).
const REF_VALUE_RE = /(RF\d{2}[\d ]{2,30}|\d[\d ]{2,28}\d)/;
const INVOICE_VALUE_RE = /([A-Za-z]{0,8}[-/]?\d[A-Za-z\d/-]{0,30})/;

function findLabeledValue(
  lines: string[],
  labelRe: RegExp,
  valueRe: RegExp
): string | null {
  for (let i = 0; i < lines.length; i++) {
    const labelMatch = lines[i].match(labelRe);
    if (!labelMatch || labelMatch.index === undefined) continue;
    const valueColumn = labelMatch.index;
    // Value on the label line or, in layout-preserving PDF text, directly
    // below the label's horizontal column. This avoids mistaking a postal code
    // in the recipient column for an invoice/reference value.
    const afterLabel = lines[i].slice(valueColumn + labelMatch[0].length);
    const same = afterLabel.match(valueRe);
    if (same) return same[1].trim();
    for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
      const aligned = lines[j].slice(valueColumn);
      const below = aligned.match(valueRe);
      if (below) return below[1].trim();
    }
  }
  return null;
}

export function extractReferenceFields(text: string): {
  reference: string | null;
  invoiceNumber: string | null;
} {
  const lines = text.split("\n");

  // Finnish payment slip: full viite after JN (OCR often breaks column alignment).
  const jn = text.match(/\bJN\s+((?:\d[\d ]{4,}\d))/i);
  if (jn) {
    return {
      reference: jn[1].trim(),
      invoiceNumber: extractInvoiceNumber(lines, text),
    };
  }

  let reference = findLabeledValue(
    lines,
    /viitenumero|viitenro|maksuviite|maksun\s+viite|maksettava.*viite|\bviite\b/i,
    REF_VALUE_RE
  );
  if (reference && reference.replace(/\D/g, "").length < 5) {
    reference = null;
  }
  if (!reference) {
    const slip = text.match(/viitenumeroa?\.\s*((?:\d[\d ]{4,}\d))/i);
    if (slip) reference = slip[1].trim();
  }

  return {
    reference,
    invoiceNumber: extractInvoiceNumber(lines, text),
  };
}

function extractInvoiceNumber(lines: string[], text: string): string | null {
  let invoiceNumber = findLabeledValue(
    lines,
    /laskun\s*(?:numero|nro)|laskunumero|tilausnumero|tilaus\s*nro|invoice\s*(?:no|number)/i,
    INVOICE_VALUE_RE
  );
  if (!invoiceNumber) {
    const order = text.match(/kuitti\s+tilaukselle\s+(\d+)/i);
    if (order) invoiceNumber = order[1];
  }
  return invoiceNumber;
}

const KNOWN_VAT_RATES = [25.5, 24, 14, 13.5, 10, 0];

function extractSummaryTableTotals(lines: string[]): {
  total: number | null;
  vat: { rate: number; amount: number }[];
} {
  for (let i = 0; i < lines.length; i++) {
    if (!/verokanta|veroton|veron\s+m[äa][äa]r[äa]|verollinen/i.test(lines[i])) {
      continue;
    }
    for (let j = i + 1; j <= i + 6 && j < lines.length; j++) {
      if (!/yhteens[äa]/i.test(lines[j]) || /tuotteet\s+yhteens/i.test(lines[j])) {
        continue;
      }
      const amounts = amountsOnLine(lines[j]);
      if (amounts.length < 3) continue;
      let rate = 25.5;
      for (let k = i + 1; k <= j; k++) {
        const rateMatch = lines[k].match(
          /(?<![\d,.])(25[,.]50?|24|14|13[,.]50?|10|0)\s*%(?![\d%])/
        );
        if (rateMatch) {
          rate = parseFloat(rateMatch[1].replace(",", "."));
          break;
        }
      }
      return {
        total: amounts[amounts.length - 1],
        vat: [{ rate, amount: amounts[amounts.length - 2] }],
      };
    }
  }
  return { total: null, vat: [] };
}

function extractTotalAmount(lines: string[]): number | null {
  const summary = extractSummaryTableTotals(lines);
  if (summary.total != null) return summary.total;

  type Candidate = { amount: number; score: number };
  const candidates: Candidate[] = [];

  const addCandidate = (amount: number, score: number, line: string) => {
    if (!Number.isFinite(amount) || amount <= 0) return;
    if (
      /veroton|a-hinta|tuotteet\s+yhteens|alennus/i.test(line) &&
      score < 80
    ) {
      return;
    }
    candidates.push({ amount, score });
  };

  for (const line of lines) {
    const amounts = amountsOnLine(line);

    const euroMatch = line.match(/\b(?:euro|eur)\s*([\d .]+\d,\d{2})/i);
    if (euroMatch) {
      addCandidate(parseAmount(euroMatch[1]), 85, line);
    }

    if (/^summa\b/i.test(line.trim()) || /\bsumma\s+/i.test(line)) {
      if (amounts.length) addCandidate(amounts[amounts.length - 1], 90, line);
    }

    if (
      /lasku\s+yhteens|maksettava|loppusumma|maksettavaa/i.test(line) &&
      !/veroton/i.test(line)
    ) {
      if (amounts.length) addCandidate(amounts[amounts.length - 1], 95, line);
    }

    if (
      /\byhteens[äa]\b/i.test(line) &&
      !/tuotteet\s+yhteens|veroton|verokanta|veron\s+m/i.test(line)
    ) {
      const score = /maksettu|maksutapa|kustom/i.test(line) ? 88 : 75;
      if (amounts.length) addCandidate(amounts[amounts.length - 1], score, line);
    }

    if (/maksettu/i.test(line) && amounts.length) {
      addCandidate(amounts[amounts.length - 1], 92, line);
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || b.amount - a.amount);
  return candidates[0].amount;
}

function extractDate(lines: string[]): string | null {
  const priorityPatterns = [
    /maksum[äa][äa]r[äa]yksen\s+p[äa]iv[äa]/i,
    /maksun\s+kirjausp[äa]iv[äa]/i,
    /laskun\s+p[äa]iv[äa]\b/i,
    /(laskun\s+)?p[äa]iv[äa](m[äa][äa]r[äa]|ys)/i,
  ];

  for (const labelRe of priorityPatterns) {
    for (let i = 0; i < lines.length; i++) {
      if (!labelRe.test(lines[i])) continue;
      if (/er[äa]p[äa]iv[äa]/i.test(lines[i]) && !/laskun\s+p[äa]iv/i.test(lines[i])) {
        continue;
      }
      for (let j = i; j <= i + 3 && j < lines.length; j++) {
        const m = lines[j].match(DATE_RE);
        if (m) return isoFromDateMatch(m);
      }
    }
  }

  for (const line of lines) {
    if (/^maksukuitti\b/i.test(line.trim())) continue;
    const m = line.match(DATE_RE);
    if (m) return isoFromDateMatch(m);
  }
  return null;
}

function extractVendor(lines: string[]): string | null {
  for (const line of lines) {
    const recipient = line.match(/vastaanottaja\s+(.+)/i);
    if (recipient) {
      const value = recipient[1].trim();
      if (value.length >= 2 && !/^[-.]$/.test(value)) return value;
    }
  }

  for (const line of lines) {
    if (
      /keskin[äa]inen\s+ty[öo]el[äa]kevakuutusyhti[öo]\s+varma|ty[öo]el[äa]kevakuutusyhti[öo]\s+varma/i.test(
        line
      )
    ) {
      return "Varma";
    }
  }
  if (
    lines.some((line) => /yel-vakuutus/i.test(line)) &&
    lines.some((line) => /\bvarma\b/i.test(line))
  ) {
    return "Varma";
  }

  for (const line of lines) {
    const businessIdSeller = line.match(
      /^\s*([A-ZÅÄÖ][^,]{1,100}?\b(?:Oy(?:j)?|Ab|ry|kunta))\s*,.*\bY-tunnus\b/i
    );
    if (businessIdSeller) return businessIdSeller[1].trim();
  }

  const labelWords =
    /p[äa]iv[äa]m[äa][äa]r[äa]|er[äa]p[äa]iv[äa]|p[äa]iv[äa]ys|laskun numero|viitenumero|asiakasnumero|sopimusnumero|y-tunnus|viitteenne|vakuutu|maksaja|m[äa][äa]r[äa]|yksikk[öo]|a-hinta|veroton|arvonlis[äa]vero|tilinumero|iban|bic/i;
  const genericStart =
    /^(lasku|kuitti|invoice|tosite|maksumuistutus|maksukuitti|sivu|tuotteen|palvelun|selite|verkkolasku|e-?lasku)(\s|\/|$)/i;
  const streetLine =
    /^\S*(tie|katu|kuja|polku|v[äa]yl[äa]|ranta|rinne|raitti)\s+\d/i;

  let seenContent = false;
  for (const raw of lines.slice(0, 30)) {
    let l = raw.trim().replace(/\s{2,}/g, " ");
    const isFirstContent = !seenContent && l.length > 0;
    if (l.length > 0) seenContent = true;
    if (!isFirstContent && /^\d{5}\s+\S+$/.test(l)) continue;
    if (streetLine.test(l)) continue;
    l = l
      .replace(/\b(LASKU|KUITTI|INVOICE)\b/g, " ")
      .replace(/Sivu\s*\d+\s*[/(]\s*\d+\)?/gi, " ")
      .replace(/^\d+\s+/, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (l.length < 3) continue;
    if (genericStart.test(l)) continue;
    if (labelWords.test(l)) continue;
    if (!/[a-zäöå]/i.test(l)) continue;
    if (/^pl\s+\d+/i.test(l) && /\bvarma\b/i.test(l)) return "Varma";
    return l;
  }
  return null;
}

function ocrConfidence(
  vendor: string | null,
  date: string | null,
  totalAmount: number | null,
  vatDetails: { rate: number; amount: number }[],
  reference: string | null
): number {
  let score = 0.2;
  if (vendor && !/^maksukuitti\b|^pl\s+\d/i.test(vendor)) score += 0.25;
  if (date) score += 0.2;
  if (totalAmount != null && totalAmount > 0) score += 0.25;
  if (reference) score += 0.05;
  if (
    totalAmount &&
    vatDetails.length &&
    vatDetails.reduce((sum, row) => sum + row.amount, 0) <= totalAmount + 0.02
  ) {
    score += 0.1;
  }
  return Math.min(0.95, Math.round(score * 100) / 100);
}

function enrichExtractedReceipt(extracted: ExtractedReceipt): ExtractedReceipt {
  const text = extracted.rawText ?? "";
  const guess = guessVatForReceipt({
    category: extracted.category,
    vendor: extracted.vendor,
    text,
    totalAmount: extracted.totalAmount,
    existingVatDetails: extracted.vatDetails,
  });
  if (!guess) return extracted;

  const notes = [extracted.notes, guess.note].filter(Boolean).join(" ") || null;
  return {
    ...extracted,
    vatDetails: guess.vatDetails,
    notes,
    confidence: Math.min(extracted.confidence, guess.confidence),
  };
}

function parseOCRText(text: string): ExtractedReceipt {
  const lines = text.split("\n");

  const summaryTable = extractSummaryTableTotals(lines);
  const totalAmount = extractTotalAmount(lines);
  const date = extractDate(lines);
  const vendor = extractVendor(lines);

  // --- VAT breakdown: identify the tax column by validating
  // tax-free amount × rate ≈ tax. Summary rows are normally the largest
  // valid tax candidate for a rate, so component rows cannot replace them.
  const vatCandidates = new Map<number, number[]>();
  for (const line of lines) {
    const rateMatch = line.match(
      /(?<![\d,.])(25[,.]50?|24|14|13[,.]50?|10|0)\s*%(?![\d%])/
    );
    if (!rateMatch || rateMatch.index === undefined) continue;
    const rate = parseFloat(rateMatch[1].replace(",", "."));
    if (!KNOWN_VAT_RATES.includes(rate)) continue;
    const withoutRate =
      line.slice(0, rateMatch.index) +
      " " +
      line.slice(rateMatch.index + rateMatch[0].length);
    const nums = amountsOnLine(withoutRate);
    const candidates: number[] = [];
    if (nums.length === 1 && /\b(?:ALV|VAT|Vero)\b/i.test(line)) {
      candidates.push(nums[0]);
    } else {
      for (let baseIndex = 0; baseIndex < nums.length; baseIndex++) {
        const expected = (nums[baseIndex] * rate) / 100;
        for (let taxIndex = 0; taxIndex < nums.length; taxIndex++) {
          if (taxIndex === baseIndex) continue;
          if (Math.abs(nums[taxIndex] - expected) < 0.06) {
            candidates.push(nums[taxIndex]);
          }
        }
      }
    }
    if (candidates.length > 0) {
      vatCandidates.set(rate, [...(vatCandidates.get(rate) || []), ...candidates]);
    }
  }
  let vatDetails = [...vatCandidates.entries()].map(([rate, candidates]) => ({
    rate,
    amount: Math.max(...candidates),
  }));
  if (summaryTable.vat.length > 0) {
    vatDetails = summaryTable.vat;
  }

  const refs = extractReferenceFields(text);
  const category = guessCategory(vendor, text);

  return enrichExtractedReceipt({
    vendor,
    date,
    totalAmount,
    vatDetails,
    category,
    notes: null,
    type: "meno",
    reference: refs.reference,
    invoiceNumber: refs.invoiceNumber,
    source: "ocr",
    provenance: "local-ocr",
    confidence: ocrConfidence(vendor, date, totalAmount, vatDetails, refs.reference),
    rawText: text,
  });
}

export {
  extractPDFText,
  parseOCRText,
  extractDocumentText,
  CATEGORIES,
  RECEIPT_CATEGORY_IDS,
};
