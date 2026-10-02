/**
 * A receipt sent into the chat (POST /api/ai/chat/receipt).
 *
 * The file is read at once (no background job: the answer is the reply), kept
 * as a pending receipt like any app upload, and the bank row it fits is
 * offered as the same match proposal the "kohdista" chat turn makes. Nothing
 * is linked or approved here: accepting the proposal (PATCH /api/ai/chat) is
 * the user's step.
 */
import { prisma } from "./db";
import {
  extractReceipt,
  isUnreadableDocumentError,
  unreadableExtraction,
  type ExtractedReceipt,
} from "./ai";
import { buildMatchProposal, type ChatMatchProposal } from "./ai-assistant";
import { candidatesForReceipt, runMatching, type MatchTx } from "./matching";
import { centsToEuros } from "./money";
import { ensureReceiptPreviewImage } from "./preview";
import {
  UploadValidationError,
  removeUserUpload,
  resolveUserUploadPath,
  safeOriginalName,
  sha256,
  validateUploadBuffer,
  writePrivateUpload,
  type DetectedFile,
} from "./storage";
import {
  INBOX_UPLOAD_RETENTION_MS,
  discardStagedUpload,
  extractedFromStagedUpload,
  receiptFieldsFromExtraction,
} from "./receipt-staging";
import {
  ChatConversationMissingError,
  createConversation,
  rememberConversationTitle,
  requireOpenConversation,
  runAssistantTurn,
} from "./chat-store";
import { mapMessage } from "./chat-message-view";
import type { ChatSource } from "./chat-turn";
import { parseBusinessDetails, generateProfileSummary } from "./onboarding";
import { randomUUID } from "crypto";

type Extractor = typeof extractReceipt;

let extractor: Extractor = extractReceipt;

/** Tests replace OCR / the paid model so a receipt can be read without either. */
export function setChatReceiptExtractorForTests(fn: Extractor | null): void {
  extractor = fn ?? extractReceipt;
}

export class ChatReceiptError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ChatReceiptError";
    this.status = status;
  }
}

export const CHAT_RECEIPT_TEXT = {
  unreadable: "En saanut kuitista selvää. Tallensin sen kuitteihin, täydennä tiedot käsin.",
  duplicate: "Tämä kuitti on jo tallennettu.",
  saved: "Tallensin sen kuitteihin tarkistettavaksi.",
  noMatch: "En löytänyt sille vielä pankkitapahtumaa. Kohdistan sen, kun tapahtuma tulee pankista.",
  linked: "Se on jo kohdistettu pankkitapahtumaan.",
  rejected: "Se on merkitty kuiteissa hylätyksi, joten en kohdista sitä.",
} as const;

/** Stored on a reply without a match so a retry can still answer with its receipt. */
const RECEIPT_MARKER = "chat_receipt";

function isUniqueConflict(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002";
}

function money(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

function finnishNumber(value: number): string {
  return String(value).replace(".", ",");
}

function dayMonthYear(date: Date): string {
  return `${date.getUTCDate()}.${date.getUTCMonth() + 1}.${date.getUTCFullYear()}`;
}

function monthOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function vatLines(raw: string | null): Array<{ rate: number; amount: number }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ rate?: unknown; amount?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((line) =>
      typeof line?.rate === "number" && typeof line?.amount === "number" && line.amount > 0
        ? [{ rate: line.rate, amount: line.amount }]
        : []
    );
  } catch {
    return [];
  }
}

interface StoredReceipt {
  id: string;
  vendor: string | null;
  date: Date | null;
  totalAmountCents: number | null;
  vatDetails: string | null;
  type: string;
  reference: string | null;
  invoiceNumber: string | null;
  fileName: string;
  reviewStatus: string;
  createdAt: Date;
}

const RECEIPT_SELECT = {
  id: true,
  vendor: true,
  date: true,
  totalAmountCents: true,
  vatDetails: true,
  type: true,
  reference: true,
  invoiceNumber: true,
  fileName: true,
  reviewStatus: true,
  createdAt: true,
} as const;

/** "Luin kuitin: **K-Market**, 8,90 €, 20.9.2026, ALV 13,5 % 1,06 €." */
function readLine(receipt: StoredReceipt): string {
  const parts = [
    receipt.vendor?.trim() ? `**${receipt.vendor.trim()}**` : "myyjä puuttuu",
    receipt.totalAmountCents != null ? `${money(receipt.totalAmountCents)} €` : "summa puuttuu",
    receipt.date ? dayMonthYear(receipt.date) : "päivä puuttuu",
    ...vatLines(receipt.vatDetails).map(
      (line) => `ALV ${finnishNumber(line.rate)} % ${line.amount.toFixed(2).replace(".", ",")} €`
    ),
  ];
  return `Luin kuitin: ${parts.join(", ")}.`;
}

async function extractionContext(userId: string): Promise<{ profileContext: string; vendorPriors: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { businessDetails: true } });
  const profileContext = generateProfileSummary(parseBusinessDetails(user?.businessDetails));
  let vendorPriors = "";
  try {
    const { getTopVendorsForAiPrompt } = await import("./vendor-intelligence");
    vendorPriors = await getTopVendorsForAiPrompt(userId);
  } catch (error) {
    console.error("Failed to fetch vendor priors", error);
  }
  return { profileContext, vendorPriors };
}

/** Any failure to read the file still keeps the receipt: the user types it in. */
async function readFile(userId: string, absolutePath: string, mimeType: string): Promise<ExtractedReceipt> {
  const { profileContext, vendorPriors } = await extractionContext(userId);
  let extracted: ExtractedReceipt;
  try {
    extracted = await extractor(absolutePath, mimeType, profileContext, vendorPriors);
  } catch (error) {
    if (!isUnreadableDocumentError(error)) console.error("Chat receipt extraction failed:", error);
    extracted = unreadableExtraction();
  }
  await ensureReceiptPreviewImage(absolutePath, mimeType).catch((error) =>
    console.warn("Preview generation failed:", error)
  );
  return extracted;
}

function extractionSource(extracted: ExtractedReceipt): "ai" | "ocr" | "manual" {
  if (extracted.unreadable) return "manual";
  return extracted.source === "ai" ? "ai" : "ocr";
}

function uploadExtractionData(extracted: ExtractedReceipt) {
  return {
    extractedJson: JSON.stringify({
      vendor: extracted.vendor,
      date: extracted.date,
      totalAmount: extracted.totalAmount,
      vatDetails: extracted.vatDetails,
      category: extracted.category,
      notes: extracted.notes,
      type: extracted.type,
      reference: extracted.reference,
      invoiceNumber: extracted.invoiceNumber,
    }),
    extractionSource: extractionSource(extracted),
    confidence: Number.isFinite(extracted.confidence) ? Math.min(1, Math.max(0, extracted.confidence)) : null,
    rawText: typeof extracted.rawText === "string" ? extracted.rawText.slice(0, 100_000) : null,
  };
}

/** The receipt's own date only: a file sent today is not dated today unless it says so. */
function extractedDate(extracted: ExtractedReceipt): Date | null {
  if (extracted.unreadable || !extracted.date) return null;
  const date = new Date(extracted.date);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function createReceiptFromUpload(
  userId: string,
  upload: { id: string; storageKey: string },
  fileName: string,
  extracted: ExtractedReceipt,
  uploadUpdate: Partial<ReturnType<typeof uploadExtractionData>>
): Promise<StoredReceipt> {
  const source = extractionSource(extracted);
  return prisma.$transaction(async (tx) => {
    await tx.upload.update({
      where: { id: upload.id },
      data: {
        ...uploadUpdate,
        claimedAt: new Date(),
        expiresAt: new Date(Date.now() + INBOX_UPLOAD_RETENTION_MS),
      },
    });
    return tx.receipt.create({
      data: {
        userId,
        uploadId: upload.id,
        filePath: upload.storageKey,
        fileName,
        // Same as an app upload saved from the editor (receipts/save): how it was read.
        source,
        reviewStatus: "pending",
        ...receiptFieldsFromExtraction(extracted, new Date()),
        date: extractedDate(extracted),
        confidence: source === "manual" ? null : extracted.confidence,
      },
      select: RECEIPT_SELECT,
    });
  });
}

interface ResolvedReceipt {
  receipt: StoredReceipt;
  duplicate: boolean;
  unreadable: boolean;
}

/** The receipt for these bytes: the stored one (sha256), or a new pending one. */
async function resolveReceipt(
  userId: string,
  buffer: Buffer,
  detected: DetectedFile,
  fileName: string,
  attempt = 0
): Promise<ResolvedReceipt> {
  const checksum = sha256(buffer);
  const existing = await prisma.upload.findFirst({
    where: { userId, purpose: "receipt", sha256: checksum },
  });

  if (existing) {
    const stored = await prisma.receipt.findFirst({
      where: { userId, uploadId: existing.id },
      select: RECEIPT_SELECT,
    });
    if (stored) return { receipt: stored, duplicate: true, unreadable: false };
    if (!existing.claimedAt && existing.expiresAt <= new Date()) {
      await discardStagedUpload(userId, existing);
    } else {
      // Staged by the upload screen but never saved: its file (and any reading) is reused.
      const extracted = existing.extractedJson
        ? extractedFromStagedUpload(existing)
        : await readFile(userId, resolveUserUploadPath(userId, existing.storageKey), existing.mimeType);
      const receipt = await createReceiptFromUpload(
        userId,
        existing,
        fileName,
        extracted,
        existing.extractedJson ? {} : uploadExtractionData(extracted)
      );
      return { receipt, duplicate: false, unreadable: Boolean(extracted.unreadable) };
    }
  }

  const { storageKey, absolutePath } = await writePrivateUpload(userId, detected.extension, buffer);
  let uploadId: string | null = null;
  try {
    const extracted = await readFile(userId, absolutePath, detected.mimeType);
    const upload = await prisma.upload.create({
      data: {
        userId,
        purpose: "receipt",
        storageKey,
        originalName: fileName,
        mimeType: detected.mimeType,
        sizeBytes: buffer.length,
        sha256: checksum,
        expiresAt: new Date(Date.now() + INBOX_UPLOAD_RETENTION_MS),
        ...uploadExtractionData(extracted),
      },
    });
    uploadId = upload.id;
    const receipt = await createReceiptFromUpload(userId, upload, fileName, extracted, {});
    return { receipt, duplicate: false, unreadable: Boolean(extracted.unreadable) };
  } catch (error) {
    if (uploadId) await prisma.upload.deleteMany({ where: { id: uploadId, claimedAt: null } }).catch(() => {});
    await removeUserUpload(userId, storageKey).catch(() => {});
    // The same file arrived twice at once: the other request stored it.
    if (isUniqueConflict(error) && attempt === 0) {
      return resolveReceipt(userId, buffer, detected, fileName, 1);
    }
    throw error;
  }
}

interface BankMatch {
  proposal: ChatMatchProposal;
  month: string | null;
}

/** The best open bank row of this owner for the receipt, scored like the chat match turn. */
async function bestBankRow(userId: string, receipt: StoredReceipt): Promise<BankMatch | null> {
  const rows = await prisma.transaction.findMany({
    where: {
      statement: { userId },
      matchStatus: { in: ["unmatched", "suggested"] },
      receiptId: null,
      type: { in: ["tulo", "meno"] },
    },
    select: {
      id: true,
      date: true,
      counterparty: true,
      amountCents: true,
      reference: true,
      message: true,
      type: true,
      statement: { select: { periodMonth: true } },
    },
  });
  if (rows.length === 0) return null;
  const rejections = await prisma.matchRejection.findMany({
    where: { receiptId: receipt.id, transaction: { statement: { userId } } },
    select: { transactionId: true, receiptId: true },
  });
  const rejected = new Set(rejections.map((r) => `${r.transactionId}:${r.receiptId}`));
  const txs: MatchTx[] = rows.map((row) => ({
    id: row.id,
    date: row.date,
    counterparty: row.counterparty,
    amount: centsToEuros(row.amountCents),
    reference: row.reference,
    message: row.message,
    type: row.type,
  }));
  const [best] = candidatesForReceipt(
    {
      id: receipt.id,
      vendor: receipt.vendor,
      date: receipt.date,
      totalAmount: receipt.totalAmountCents == null ? null : centsToEuros(receipt.totalAmountCents),
      type: receipt.type,
      reference: receipt.reference,
      invoiceNumber: receipt.invoiceNumber,
      reviewStatus: receipt.reviewStatus,
    },
    txs,
    rejected,
    1
  );
  if (!best) return null;
  const row = rows.find((candidate) => candidate.id === best.transactionId);
  if (!row) return null;
  return {
    proposal: buildMatchProposal(row, receipt, best),
    month: row.date ? monthOf(row.date) : row.statement.periodMonth || null,
  };
}

function bankRowHref(month: string | null, transactionId: string): string {
  const params = new URLSearchParams();
  if (month) params.set("month", month);
  params.set("rivi", transactionId);
  return `/pankki/tapahtumat?${params.toString()}`;
}

interface Reply {
  content: string;
  proposal: ChatMatchProposal | null;
  sources: ChatSource[];
}

async function composeReply(userId: string, resolved: ResolvedReceipt): Promise<Reply> {
  const { receipt } = resolved;
  const sources: ChatSource[] = [{ label: "Avaa kuitti", href: `/kuitit/kuitti?id=${receipt.id}` }];
  if (resolved.unreadable) return { content: CHAT_RECEIPT_TEXT.unreadable, proposal: null, sources };

  const opening = resolved.duplicate
    ? CHAT_RECEIPT_TEXT.duplicate
    : `${readLine(receipt)} ${CHAT_RECEIPT_TEXT.saved}`;

  const linked = await prisma.transaction.findFirst({
    where: { receiptId: receipt.id, statement: { userId } },
    select: { id: true, date: true, statement: { select: { periodMonth: true } } },
  });
  if (linked) {
    sources.push({
      label: "Avaa pankkitapahtuma",
      href: bankRowHref(linked.date ? monthOf(linked.date) : linked.statement.periodMonth || null, linked.id),
    });
    return { content: `${opening} ${CHAT_RECEIPT_TEXT.linked}`, proposal: null, sources };
  }
  if (receipt.reviewStatus === "rejected") {
    return { content: `${opening} ${CHAT_RECEIPT_TEXT.rejected}`, proposal: null, sources };
  }

  const match = await bestBankRow(userId, receipt);
  if (!match) return { content: `${opening} ${CHAT_RECEIPT_TEXT.noMatch}`, proposal: null, sources };
  sources.push({ label: "Avaa pankkitapahtuma", href: bankRowHref(match.month, match.proposal.transactionId) });
  return {
    content: `${opening} Se sopii pankkitapahtumaan ${match.proposal.txSummary}. Hyväksy kohdistus alta.`,
    proposal: match.proposal,
    sources,
  };
}

function storedReceiptId(proposalData: string | null): string | null {
  if (!proposalData) return null;
  try {
    const parsed = JSON.parse(proposalData) as { receiptId?: unknown };
    return typeof parsed.receiptId === "string" ? parsed.receiptId : null;
  } catch {
    return null;
  }
}

export interface ChatReceiptInput {
  userId: string;
  file: { name: string; buffer: Buffer };
  conversationId?: string;
  clientId?: string;
  signal?: AbortSignal;
}

export type ChatMessageView = ReturnType<typeof mapMessage>;

export interface ChatReceiptResult {
  conversationId: string;
  receiptId: string;
  userMessage: ChatMessageView;
  assistantMessage: ChatMessageView;
}

async function answer(userMessageId: string, assistantMessageId: string): Promise<ChatReceiptResult> {
  const [userRow, assistantRow] = await Promise.all([
    prisma.chatMessage.findUniqueOrThrow({ where: { id: userMessageId } }),
    prisma.chatMessage.findUniqueOrThrow({ where: { id: assistantMessageId } }),
  ]);
  const receiptId = storedReceiptId(assistantRow.proposalData);
  if (!receiptId) throw new Error("Chat receipt reply has no receipt");
  return {
    conversationId: userRow.conversationId,
    receiptId,
    userMessage: mapMessage(userRow),
    assistantMessage: mapMessage(assistantRow),
  };
}

/** The user's file as a chat turn: "Kuitti: <name>" and the assistant's reading of it. */
export async function sendReceiptToChat(input: ChatReceiptInput): Promise<ChatReceiptResult> {
  const clientId = input.clientId?.trim() ?? "";
  const requestedConversation = input.conversationId?.trim() ?? "";
  if (clientId && (clientId.length < 8 || clientId.length > 80)) {
    throw new ChatReceiptError("Virheellinen viestin tunniste", 400);
  }

  const fileName = safeOriginalName(input.file.name);
  let detected: DetectedFile;
  try {
    detected = validateUploadBuffer(input.file.buffer, fileName, "receipt");
  } catch (error) {
    if (error instanceof UploadValidationError) {
      const tooLarge = error.status === 413 && input.file.buffer.length > 0;
      throw new ChatReceiptError(error.message, tooLarge ? 413 : 400);
    }
    throw error;
  }
  const content = `Kuitti: ${fileName}`;

  // A retry of a send whose answer was lost: the first answer, without reading the file again.
  let userRow = clientId
    ? await prisma.chatMessage.findFirst({ where: { userId: input.userId, clientId } })
    : null;
  if (userRow) {
    if (
      userRow.role !== "user" ||
      userRow.content !== content ||
      (requestedConversation && userRow.conversationId !== requestedConversation)
    ) {
      throw new ChatReceiptError("Viestin tunniste on jo käytössä", 409);
    }
    const reply = await prisma.chatMessage.findFirst({
      where: { replyToId: userRow.id, userId: input.userId, status: "complete" },
      select: { id: true, proposalData: true },
    });
    if (reply && storedReceiptId(reply.proposalData)) return answer(userRow.id, reply.id);
  }

  const conversationId = userRow?.conversationId ?? requestedConversation;
  let conversation;
  if (conversationId) {
    try {
      conversation = await requireOpenConversation(input.userId, conversationId);
    } catch (error) {
      if (error instanceof ChatConversationMissingError) throw new ChatReceiptError(error.message, 404);
      throw error;
    }
  } else {
    conversation = await createConversation(input.userId);
  }
  if (conversation.archivedAt) throw new ChatReceiptError("Keskustelu on arkistoitu.", 409);

  const retryOf = userRow;
  if (!userRow) {
    try {
      userRow = await prisma.chatMessage.create({
        data: {
          userId: input.userId,
          conversationId: conversation.id,
          role: "user",
          content,
          clientId: clientId || null,
          status: "complete",
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error) || !clientId) throw error;
      // The same send is running right now; its reply will answer both.
      throw new ChatReceiptError("Vastaus on jo tekeillä.", 409);
    }
    await rememberConversationTitle(conversation.id, input.userId, content);
  }

  const resolved = await resolveReceipt(input.userId, input.file.buffer, detected, fileName);
  // A retry finds the receipt its own first attempt stored: that is not a duplicate.
  if (resolved.duplicate && retryOf && resolved.receipt.createdAt >= retryOf.createdAt) {
    resolved.duplicate = false;
  }
  if (!resolved.duplicate) {
    // Keeps the bank screen's suggestions in step, as saving a receipt does.
    await runMatching(input.userId).catch((error) =>
      console.error("Matching after chat receipt failed:", error)
    );
  }

  const reply = await composeReply(input.userId, resolved);
  const proposalData = reply.proposal
    ? JSON.stringify({ ...reply.proposal, limited: false })
    : JSON.stringify({ type: RECEIPT_MARKER, receiptId: resolved.receipt.id });
  const turn = await runAssistantTurn({
    userId: input.userId,
    conversationId: conversation.id,
    userMessageId: userRow.id,
    owner: randomUUID(),
    signal: input.signal ?? new AbortController().signal,
    local: { content: reply.content, proposalData, sources: reply.sources },
  });
  return answer(userRow.id, turn.messageId);
}
