import "dotenv/config";
import { extractReceipt, extractPDFText } from "../src/lib/ai";

const files = [
  { path: "/home/hhusey/Downloads/Pb lashlift kuitti.pdf", mime: "application/pdf" },
  { path: "/home/hhusey/Downloads/Yth kuitti.pdf", mime: "application/pdf" },
  { path: "/home/hhusey/Downloads/Lasku varma työeläke.HEIC", mime: "image/heic" },
];

async function main() {
  for (const f of files) {
    console.log("\n==========", f.path.split("/").pop(), "==========");
    try {
      const r = await extractReceipt(f.path, f.mime);
      console.log(
        JSON.stringify(
          {
            vendor: r.vendor,
            date: r.date,
            totalAmount: r.totalAmount,
            vatDetails: r.vatDetails,
            reference: r.reference,
            invoiceNumber: r.invoiceNumber,
            category: r.category,
            confidence: r.confidence,
            source: r.source,
          },
          null,
          2
        )
      );
      if (f.mime === "application/pdf") {
        const t = await extractPDFText(f.path);
        console.log("PDF text length:", t.trim().length);
        console.log("--- PDF text ---\n", t.slice(0, 1500));
      }
      if (r.rawText) {
        console.log("--- OCR text ---\n", r.rawText.slice(0, 1500));
      }
    } catch (e) {
      console.error("ERROR:", e);
    }
  }
}

main();
