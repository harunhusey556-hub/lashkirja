import { prisma } from "./db";
import { confirmMatch, MatchConflictError, MatchNotFoundError, runMatching } from "./matching";
import { PeriodLockedError } from "./period-lock";
import { serverApprovalBlock } from "./receipt-approval";
import { AppError } from "./api-errors";
import {
  acceptInvoiceDraft,
  acceptReceiptUpdate,
  type InvoiceDraftProposal,
  type ReceiptUpdateProposal,
} from "./chat-tools-propose";

export const INCOMPLETE_RECEIPT_MESSAGE = "Täydennä kuitin tiedot ennen kohdistusta.";

export class ChatDecisionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ChatDecisionError";
    this.status = status;
  }
}

interface MatchProposal {
  type?: string;
  transactionId?: string;
  receiptId?: string;
  status?: string;
  [key: string]: unknown;
}

function readProposal(raw: string | null): MatchProposal {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as MatchProposal;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The match write and the chat decision commit together. A failure in either
 * leaves both unchanged. Accepting also approves a pending receipt (in the
 * same transaction); an incomplete one is refused with 422.
 */
export async function decideChatProposal(
  input: { userId: string; messageId: string; decision: "accepted" | "rejected" },
  hooks?: { beforeChatWrite?: () => void }
) {
  const message = await prisma.chatMessage.findFirst({
    where: { id: input.messageId, userId: input.userId, role: "assistant" },
  });
  if (!message) throw new ChatDecisionError("Viestiä ei löydy", 404);
  const proposal = readProposal(message.proposalData);
  if (proposal.type === "invoice_draft" || proposal.type === "receipt_update") {
    return decideActionProposal(message, proposal, input, hooks);
  }
  if (proposal.type !== "match_proposal" || !proposal.transactionId || !proposal.receiptId) {
    throw new ChatDecisionError("Viestissä ei ole kohdistusehdotusta", 400);
  }
  if (proposal.status === input.decision) return message;
  if (proposal.status === "accepted" || proposal.status === "rejected") {
    throw new ChatDecisionError("Päätös on jo tallennettu", 409);
  }

  const next = JSON.stringify({ ...proposal, status: input.decision });
  try {
    await prisma.$transaction(async (tx) => {
      if (input.decision === "accepted") {
        // Accepting approves a waiting receipt (confirmMatch), and only a
        // complete one may be approved: no amount or no date is not bookable.
        const receipt = await tx.receipt.findFirst({
          where: { id: proposal.receiptId, userId: input.userId },
          select: { reviewStatus: true, totalAmountCents: true, date: true },
        });
        if (receipt?.reviewStatus === "pending" && (serverApprovalBlock(receipt) || !receipt.date)) {
          throw new ChatDecisionError(INCOMPLETE_RECEIPT_MESSAGE, 422);
        }
        const bankRow = await tx.transaction.findFirst({
          where: { id: proposal.transactionId, statement: { userId: input.userId } },
          select: { suggestedReceiptId: true },
        });
        await confirmMatch(
          input.userId,
          proposal.transactionId!,
          proposal.receiptId!,
          bankRow?.suggestedReceiptId === proposal.receiptId,
          tx
        );
      } else {
        const bankRow = await tx.transaction.findFirst({
          where: { id: proposal.transactionId, statement: { userId: input.userId } },
        });
        if (!bankRow) throw new MatchNotFoundError();
        await tx.matchRejection.upsert({
          where: {
            transactionId_receiptId: {
              transactionId: proposal.transactionId!,
              receiptId: proposal.receiptId!,
            },
          },
          create: { transactionId: proposal.transactionId!, receiptId: proposal.receiptId! },
          update: {},
        });
        if (bankRow.suggestedReceiptId === proposal.receiptId) {
          await tx.transaction.update({
            where: { id: bankRow.id },
            data: {
              matchStatus: "unmatched",
              suggestedReceiptId: null,
              matchScore: null,
              matchReasons: null,
            },
          });
        }
      }
      hooks?.beforeChatWrite?.();
      await tx.chatMessage.update({
        where: { id: message.id },
        data: { proposalData: next },
      });
    });
  } catch (error) {
    if (error instanceof MatchNotFoundError) throw new ChatDecisionError("Ei löytynyt", 404);
    if (error instanceof MatchConflictError) throw new ChatDecisionError(error.message, 409);
    if (error instanceof PeriodLockedError) throw new ChatDecisionError(error.message, error.statusCode);
    if (error instanceof ChatDecisionError) throw error;
    throw error;
  }

  if (input.decision === "rejected") {
    try {
      await runMatching(input.userId);
    } catch (error) {
      console.error("Matching after chat rejection failed:", error);
    }
  }

  return prisma.chatMessage.findFirst({ where: { id: message.id, userId: input.userId } });
}

type ActionProposal = (InvoiceDraftProposal | ReceiptUpdateProposal) & { status?: string };

/**
 * Hyväksy / Hylkää on a tool's proposal (chat-tools-propose.ts). Accepting
 * writes through the screens' own code: a DRAFT invoice (createInvoice) or the
 * receipt edit (period lock and edit conflicts included). The decision and
 * the write commit together, and the decision is claimed first, so a double
 * tap cannot create two invoices.
 */
async function decideActionProposal(
  message: { id: string; proposalData: string | null },
  raw: MatchProposal,
  input: { userId: string; messageId: string; decision: "accepted" | "rejected" },
  hooks?: { beforeChatWrite?: () => void }
) {
  const proposal = raw as unknown as ActionProposal;
  if (proposal.status === input.decision) return prisma.chatMessage.findFirst({ where: { id: message.id, userId: input.userId } });
  if (proposal.status === "accepted" || proposal.status === "rejected") {
    throw new ChatDecisionError("Päätös on jo tallennettu", 409);
  }
  try {
    await prisma.$transaction(async (tx) => {
      // Claim the decision against the stored text: a second request finds it changed.
      const claimed = await tx.chatMessage.updateMany({
        where: { id: message.id, userId: input.userId, proposalData: message.proposalData },
        data: { proposalData: JSON.stringify({ ...proposal, status: input.decision }) },
      });
      if (claimed.count !== 1) throw new ChatDecisionError("Päätös on jo tallennettu", 409);
      if (input.decision === "rejected") return;
      const result =
        proposal.type === "invoice_draft"
          ? await acceptInvoiceDraft(input.userId, proposal, tx)
          : await acceptReceiptUpdate(input.userId, proposal, tx);
      hooks?.beforeChatWrite?.();
      await tx.chatMessage.update({
        where: { id: message.id },
        data: { proposalData: JSON.stringify({ ...proposal, ...result, status: "accepted" }) },
      });
    });
  } catch (error) {
    if (error instanceof ChatDecisionError) throw error;
    // Period lock, a receipt edited meanwhile, an archived customer, a changed total: said as the screens say it.
    if (error instanceof AppError) throw new ChatDecisionError(error.message, error.statusCode);
    throw error;
  }
  if (input.decision === "accepted" && proposal.type === "receipt_update") {
    try {
      await runMatching(input.userId);
    } catch (error) {
      console.error("Matching after chat receipt update failed:", error);
    }
  }
  return prisma.chatMessage.findFirst({ where: { id: message.id, userId: input.userId } });
}
