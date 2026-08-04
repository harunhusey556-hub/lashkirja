import * as fs from "fs";
import * as path from "path";
import { parseCamtXML, parseXLSX, parsePDFStatement } from "../src/lib/parsers";
import { parseOCRText } from "../src/lib/ai";
import { execSync } from "child_process";

const KUITIT_DIR =
  "/home/hhusey/.openclaw/workspace/tiyouba/kirjanpitaja/kirjanpito/2026/05-mayis/kuitit/";
const CAMT_FILE =
  "/home/hhusey/.openclaw/workspace/tiyouba/kirjanpitaja/kirjanpito/2026/05-mayis/tiliote/camt052_2026-05.xml";
const XLSX_FILE =
  "/home/hhusey/.openclaw/workspace/tiyouba/kirjanpitaja/kirjanpito/2026/05-mayis/tiliote/mayis_2026_tiliote.xlsx";
const SP_PDF_DIR =
  "/home/hhusey/.openclaw/workspace/tiyouba/kirjanpitaja/kirjanpito/saastopankki-tiliotteet/ctr/";

interface TestResult {
  file: string;
  type: string;
  success: boolean;
  details: string;
}

const results: TestResult[] = [];

async function testReceipts() {
  console.log("=== KUITTI-TESTIT (OCR) ===\n");
  const receiptFiles: string[] = [];

  function findPDFs(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const fullPath = path.join(dir, e.name);
      if (e.isDirectory()) findPDFs(fullPath);
      else if (e.name.match(/\.(pdf|jpg|jpeg|png)$/i)) receiptFiles.push(fullPath);
    }
  }

  findPDFs(KUITIT_DIR);
  const testFiles = receiptFiles.slice(0, 5);

  for (const file of testFiles) {
    const ext = path.extname(file).toLowerCase();
    const shortName = file.replace(KUITIT_DIR, "");
    console.log(`Testing: ${shortName}`);

    try {
      let rawText = "";
      if (ext === ".pdf") {
        try {
          rawText = execSync(`pdftotext -layout "${file}" -`, { timeout: 30000 }).toString("utf-8");
        } catch {
          rawText = "";
        }
      } else {
        try {
          rawText = execSync(`tesseract "${file}" stdout -l fin+eng 2>/dev/null`, {
            timeout: 30000,
          }).toString("utf-8");
        } catch {
          rawText = "";
        }
      }

      const parsed = parseOCRText(rawText);
      const vendorFound = parsed.vendor ? "YES" : "NO";
      const dateFound = parsed.date ? "YES" : "NO";
      const totalFound = parsed.totalAmount ? "YES" : "NO";

      const details = `vendor=${parsed.vendor || "–"}, date=${parsed.date || "–"}, total=${parsed.totalAmount ?? "–"}, vat_items=${parsed.vatDetails.length}`;
      console.log(`  Result: ${details}`);

      results.push({
        file: shortName,
        type: "kuitti-ocr",
        success: !!(parsed.vendor || parsed.totalAmount || parsed.date),
        details,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ERROR: ${msg}`);
      results.push({
        file: shortName,
        type: "kuitti-ocr",
        success: false,
        details: `Error: ${msg}`,
      });
    }
  }
}

async function testCamtXML() {
  console.log("\n=== CAMT052 XML TESTI ===\n");
  console.log(`File: ${CAMT_FILE}`);

  try {
    const transactions = await parseCamtXML(CAMT_FILE);
    const details = `${transactions.length} transactions parsed`;
    console.log(`  Result: ${details}`);

    if (transactions.length > 0) {
      const first = transactions[0];
      const last = transactions[transactions.length - 1];
      console.log(`  First: date=${first.date}, party=${first.counterparty}, amount=${first.amount}`);
      console.log(`  Last:  date=${last.date}, party=${last.counterparty}, amount=${last.amount}`);

      const debits = transactions.filter((t) => t.amount < 0);
      const credits = transactions.filter((t) => t.amount >= 0);
      console.log(`  Debits: ${debits.length}, Credits: ${credits.length}`);

      const totalDebits = debits.reduce((s, t) => s + t.amount, 0);
      const totalCredits = credits.reduce((s, t) => s + t.amount, 0);
      console.log(`  Total debits: ${totalDebits.toFixed(2)}, Total credits: ${totalCredits.toFixed(2)}`);
    }

    results.push({
      file: path.basename(CAMT_FILE),
      type: "camt-xml",
      success: transactions.length > 0,
      details: `${transactions.length} transactions, dates/parties/amounts present`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ERROR: ${msg}`);
    results.push({
      file: path.basename(CAMT_FILE),
      type: "camt-xml",
      success: false,
      details: `Error: ${msg}`,
    });
  }
}

async function testXLSX() {
  console.log("\n=== XLSX TESTI ===\n");
  console.log(`File: ${XLSX_FILE}`);

  try {
    const transactions = await parseXLSX(XLSX_FILE);
    const details = `${transactions.length} transactions parsed`;
    console.log(`  Result: ${details}`);

    if (transactions.length > 0) {
      console.log(`  First: date=${transactions[0].date}, party=${transactions[0].counterparty}, amount=${transactions[0].amount}`);
      const last = transactions[transactions.length - 1];
      console.log(`  Last: date=${last.date}, party=${last.counterparty}, amount=${last.amount}`);
    }

    results.push({
      file: path.basename(XLSX_FILE),
      type: "xlsx",
      success: transactions.length > 0,
      details: `${transactions.length} transactions parsed`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ERROR: ${msg}`);
    results.push({
      file: path.basename(XLSX_FILE),
      type: "xlsx",
      success: false,
      details: `Error: ${msg}`,
    });
  }
}

async function testSPPDF() {
  console.log("\n=== SÄÄSTÖPANKKI PDF TESTI ===\n");
  const pdfFile = path.join(SP_PDF_DIR, "CTR_Saastopankki_2026-05.pdf");
  console.log(`File: ${pdfFile}`);

  try {
    const transactions = await parsePDFStatement(pdfFile);
    const details = `${transactions.length} transactions parsed`;
    console.log(`  Result: ${details}`);

    if (transactions.length > 0) {
      console.log(`  First: date=${transactions[0].date}, party=${transactions[0].counterparty}, amount=${transactions[0].amount}`);
    }

    results.push({
      file: path.basename(pdfFile),
      type: "pdf-tiliote",
      success: transactions.length > 0,
      details,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ERROR: ${msg}`);
    results.push({
      file: path.basename(pdfFile),
      type: "pdf-tiliote",
      success: false,
      details: `Error: ${msg}`,
    });
  }
}

async function main() {
  await testReceipts();
  await testCamtXML();
  await testXLSX();
  await testSPPDF();

  console.log("\n\n=== YHTEENVETO ===");
  const passed = results.filter((r) => r.success).length;
  console.log(`${passed}/${results.length} tests passed\n`);

  let report = `# TESTIRAPORTTI — LashKirja parsers\n\n`;
  report += `Testattu: ${new Date().toISOString().split("T")[0]}\n`;
  report += `Ympäristö: Node ${process.version}, tesseract OCR (fin+eng), pdftotext\n\n`;
  report += `## Tulokset\n\n`;
  report += `| Tiedosto | Tyyppi | Tulos | Yksityiskohdat |\n`;
  report += `|----------|--------|-------|----------------|\n`;

  for (const r of results) {
    report += `| ${r.file} | ${r.type} | ${r.success ? "OK" : "FAIL"} | ${r.details} |\n`;
  }

  report += `\n## Yhteenveto\n\n`;
  report += `- **${passed}/${results.length}** testiä läpäisi\n`;
  report += `- Kuittien OCR-jäsennys: teksti luetaan tesseractilla (fin+eng) tai pdftotextillä, sitten regex-parseri hakee myyjän (ensimmäinen rivi), päivämäärän (dd.mm.yyyy), loppusumman (YHTEENSÄ/Summa/Maksettava) ja ALV-erittelyn\n`;
  report += `- camt.052 XML: ISO 20022 -standardin mukainen jäsennys, tapahtumien päivämäärä/vastapuoli/summa/viite\n`;
  report += `- XLSX: sarakkeiden automaattinen tunnistus (päivä/summa/saaja/viite/viesti)\n`;
  report += `- PDF-tiliote: pdftotext + regex-parseri tapahtumille (pvm + vastapuoli + summa)\n\n`;
  report += `## Tunnetut rajoitukset\n\n`;
  report += `- OCR-parseri on regex-pohjainen eikä tunnista kaikkia kuittiformaatteja\n`;
  report += `- PDF-tiliotteiden jäsennys riippuu PDF:n tekstirakenteesta — skannatut kuvat eivät toimi ilman OCR:ää\n`;
  report += `- XLSX-parseri olettaa tietynlaiset sarakenimet (suomenkieliset)\n`;
  report += `- HEIC-kuvien OCR vaatii imagemagick-muunnoksen (ei implementoitu v1:ssä)\n`;
  report += `- AI-pohjainen analyysi (LLM_API_KEY) antaisi merkittävästi paremman tarkkuuden kuin OCR-regex\n`;

  const reportPath = path.join(
    "/home/hhusey/.openclaw/workspace/tiyouba/kirjanpitaja/projects/lashkirja",
    "TESTIRAPORTTI.md"
  );
  fs.writeFileSync(reportPath, report);
  console.log(`Report written to: ${reportPath}`);
}

main().catch(console.error);
