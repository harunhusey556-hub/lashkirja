import { ImapFlow, SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import { prisma } from "./db";
import { decrypt } from "./encryption";
import { extractReceipt } from "./ai";
import { runMatching } from "./matching";
import { writePrivateUpload } from "./storage";
import { ensureReceiptPreviewImage } from "./preview";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

import { createHash } from "crypto";
import { withTrackedJob } from "./job-tracker";
// We only process attachments that are likely to be receipts.
const VALID_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png", ".heic"];

// To prevent overwhelming the AI or downloading gigabytes of emails, we do a two-pass fetch:
// 1. Fetch bodyStructure to detect which emails have attachments.
// 2. Fetch the full source only for the matching UIDs.
/** The shape imapflow returns for a bodyStructure node; only what is read here. */
interface BodyStructureNode {
  disposition?: string | { value?: string };
  type?: string;
  parameters?: { name?: string };
  childNodes?: BodyStructureNode[];
}

function hasLikelyAttachment(part: BodyStructureNode | null | undefined): boolean {
  if (!part) return false;
  
  const disposition =
    typeof part.disposition === "string"
      ? part.disposition.toLowerCase()
      : (part.disposition?.value || "").toLowerCase();
  if (disposition === 'attachment') return true;
  
  const type = part.type ? part.type.toLowerCase() : '';
  if (['application/pdf', 'image/jpeg', 'image/png', 'image/heic'].includes(type)) return true;
  
  // Check filename in parameters just in case disposition is inline
  if (part.parameters && part.parameters.name) {
    const name = part.parameters.name.toLowerCase();
    if (VALID_EXTENSIONS.some(ext => name.endsWith(ext))) return true;
  }
  
  if (part.childNodes && Array.isArray(part.childNodes)) {
    for (const child of part.childNodes) {
      if (hasLikelyAttachment(child)) return true;
    }
  }
  return false;
}

function isBodyOnlyReceipt(envelope: { subject?: string } | null | undefined): boolean {
  if (!envelope || !envelope.subject) return false;
  const subject = envelope.subject.toLowerCase();
  const keywords = [
    "lasku", "kuitti", "receipt", "invoice", "payment", 
    "uber", "bolt", "apple", "tilaus", "vahvistus", 
    "maksu", "order", "tosite"
  ];
  return keywords.some(kw => subject.includes(kw));
}

/** The mailboxes a background run may read: a closed account's mailbox is never polled again (F57). */
export async function listSyncableImapAccounts() {
  return prisma.imapAccount.findMany({ where: { user: { accessDisabledAt: null } } });
}

export async function syncImapAccount(accountId: string) {
  const account = await prisma.imapAccount.findUnique({
    where: { id: accountId },
    select: { userId: true, user: { select: { accessDisabledAt: true } } },
  });
  if (!account) throw new Error("Account not found");
  if (account.user.accessDisabledAt) throw new Error("Tili on suljettu, postilaatikkoa ei tarkisteta.");
  return withTrackedJob(
    account.userId,
    {
      kind: "email_scan",
      title: "Sähköpostin tarkistus",
      resourceType: "imap_account",
      resourceId: accountId,
    },
    () => syncImapAccountUntracked(accountId)
  );
}

async function syncImapAccountUntracked(accountId: string) {
  const account = await prisma.imapAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new Error("Account not found");

  const password = decrypt(account.encryptedPass);
  
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.tls,
    auth: {
      user: account.email,
      pass: password,
    },
    logger: false,
  });

  const user = await prisma.user.findUnique({
    where: { id: account.userId },
    select: { businessDetails: true },
  });
  
  const { parseBusinessDetails, generateProfileSummary } = await import("./onboarding");
  const profileContext = user?.businessDetails ? generateProfileSummary(parseBusinessDetails(user.businessDetails)) : undefined;

  const { getTopVendorsForAiPrompt } = await import("./vendor-intelligence");
  const vendorPriors = await getTopVendorsForAiPrompt(account.userId);

  await client.connect();
  let lock;
  
  try {
    lock = await client.getMailboxLock("INBOX");
    const since = account.lastSyncAt ? account.lastSyncAt : new Date("2026-01-01");
    
    // Pass 1: Fetch structural metadata to find attachments
    const structuralMessages = client.fetch({ since }, {
      uid: true,
      bodyStructure: true,
      envelope: true,
      internalDate: true,
    });

    let maxInternalDate = account.lastSyncAt ? account.lastSyncAt.getTime() : 0;
    const uidsToFetch: number[] = [];

    for await (const msg of structuralMessages) {
      const rawDate = msg.internalDate || new Date();
      const dateObj = rawDate instanceof Date ? rawDate : new Date(rawDate);
      const msgDate = dateObj.getTime();
      if (msgDate > maxInternalDate) {
        maxInternalDate = msgDate;
      }

      if (hasLikelyAttachment(msg.bodyStructure)) {
        uidsToFetch.push(msg.uid);
      } else if (isBodyOnlyReceipt(msg.envelope)) {
        uidsToFetch.push(msg.uid);
      }
    }

    let processedCount = 0;

    // Pass 2: Fetch only the full source of emails that actually contain attachments
    if (uidsToFetch.length > 0) {
      const uidsSeq = uidsToFetch.join(",");
      const fullMessages = client.fetch(uidsSeq, {
        uid: true,
        source: true,
        envelope: true,
      }, { uid: true }); // Need to specify uid: true in options to use UID sequence

      for await (const msg of fullMessages) {
        if (!msg.source) continue;
        
        const parsed = await simpleParser(msg.source);
        
        // Define a helper to process a "file" (either an attachment or the HTML body)
        const processFile = async (contentBuffer: Buffer, filename: string, mimeType: string, date: Date | null) => {
          const ext = path.extname(filename).toLowerCase();
          
          if (!VALID_EXTENSIONS.includes(ext) && ext !== ".html") return;

          // Skip if we already processed this exact attachment (based on checksum/content)
          const checksum = createHash("sha256").update(contentBuffer).digest("hex");

          const existing = await prisma.upload.findFirst({
            where: { userId: account.userId, sha256: checksum },
          });

          if (existing) return;

          // Process this attachment
          const tempPath = path.join(os.tmpdir(), `imap-${Date.now()}-${filename.replace(/[^a-zA-Z0-9.-]/g, "_")}`);
          fs.writeFileSync(tempPath, contentBuffer);

          try {
            // 1) Run extraction
            const extraction = await extractReceipt(tempPath, mimeType, profileContext, vendorPriors);
            
            const { storageKey, absolutePath } = await writePrivateUpload(
              account.userId,
              ext,
              contentBuffer
            );
            
            await ensureReceiptPreviewImage(absolutePath, mimeType).catch((err) =>
              console.warn("Preview generation failed:", err)
            );

            const newUpload = await prisma.upload.create({
              data: {
                userId: account.userId,
                purpose: "receipt",
                storageKey,
                originalName: filename,
                mimeType,
                sizeBytes: contentBuffer.length,
                sha256: checksum,
                extractedJson: JSON.stringify(extraction),
                extractionSource: extraction.provenance,
                confidence: extraction.confidence,
                rawText: extraction.rawText,
                expiresAt: new Date(Date.now() + 86400000 * 365), // 1 year
                claimedAt: new Date(),
              },
            });

            await prisma.receipt.create({
              data: {
                userId: account.userId,
                uploadId: newUpload.id,
                vendor: extraction.vendor,
                date: extraction.date ? new Date(extraction.date) : date,
                totalAmountCents: extraction.totalAmount ? Math.round(extraction.totalAmount * 100) : null,
                vatDetails: extraction.vatDetails.length ? JSON.stringify(extraction.vatDetails) : null,
                category: extraction.category,
                notes: extraction.notes || `Haettu sähköpostista (${account.email})`,
                reference: extraction.reference,
                invoiceNumber: extraction.invoiceNumber,
                type: extraction.type,
                filePath: storageKey,
                fileName: filename,
                source: "email_sync",
                reviewStatus: "pending",
                confidence: extraction.confidence,
                rawText: extraction.rawText,
              }
            });
            processedCount++;
          } catch (error) {
            console.error("Failed to process email attachment:", error);
          } finally {
            fs.unlinkSync(tempPath);
          }
        };

        const hasAttachments = parsed.attachments && parsed.attachments.length > 0;
        
        if (hasAttachments) {
          for (const attachment of parsed.attachments) {
            const filename = attachment.filename || "unnamed";
            const mimeType = attachment.contentType || "application/octet-stream";
            await processFile(attachment.content, filename, mimeType, parsed.date || null);
          }
        } else if (msg.envelope && isBodyOnlyReceipt(msg.envelope)) {
          const rawHtml = parsed.html || parsed.textAsHtml || parsed.text || "";
          if (rawHtml.trim().length > 50) {
            const contentBuffer = Buffer.from(rawHtml, "utf8");
            const filename = `${(msg.envelope.subject || "Sähköpostikuitti").substring(0, 30)}.html`;
            await processFile(contentBuffer, filename, "text/html", parsed.date || null);
          }
        }
      }
    }

    // Update lastSyncAt
    if (maxInternalDate > 0) {
      await prisma.imapAccount.update({
        where: { id: account.id },
        data: { lastSyncAt: new Date(maxInternalDate) },
      });
    }

    if (processedCount > 0) {
      try {
        await runMatching(account.userId);
      } catch (err) {
        console.error("Failed to run matching after IMAP sync:", err);
      }
    }

    return processedCount;
  } finally {
    if (lock) {
      lock.release();
    }
    await client.logout();
  }
}
