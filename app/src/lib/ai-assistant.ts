import { prisma } from "./db";
import { parseBusinessDetails, generateProfileSummary } from "./onboarding";
import { centsToEuros } from "./money";
import { candidatesFor, MatchTx, MatchReceipt, offerableReceiptWhere } from "./matching";
import { askCopilot, type CopilotTurn } from "./copilot";
import { alvReportOf, loadAlvPeriodSources } from "./alv-period";
import {
  EMPTY_HONESTY,
  enforceAssistantReply,
  formatBookedVatAnswer,
  mergeSources,
  type HonestyContext,
} from "./chat-honesty";
import { receiptDrillHref, statementDrillHref } from "./report-drill";
import type { ChatSource, ContextTurn } from "./chat-turn";
import {
  greetingReply,
  isGreeting,
  isMatchRequest,
  limitedModeNotice,
  matchStatusReply,
  providerFailedNotice,
  prefersEnglish,
} from "./chat-policy";

export interface ChatMatchProposal {
  type: "match_proposal";
  transactionId: string;
  receiptId: string;
  txSummary: string;
  receiptSummary: string;
  confidenceScore: number;
  reasons: string[];
}

export interface ChatAssistantResult {
  reply: string;
  proposal?: ChatMatchProposal;
  limited?: boolean;
  sources?: ChatSource[];
}

export type PreparedChat =
  | {
      kind: "local";
      reply: string;
      proposal?: ChatMatchProposal;
      limited?: boolean;
      sources?: ChatSource[];
      honesty?: HonestyContext;
    }
  | {
      kind: "provider";
      systemPrompt: string;
      userMessage: string;
      english: boolean;
      sources?: ChatSource[];
      honesty: HonestyContext;
    };

/** A language model is configured, so free-form questions can be answered. */
export function assistantAvailable(): boolean {
  return Boolean(process.env.COPILOT_GITHUB_TOKEN?.trim());
}

function monthKey(date: Date | null | undefined): string | null {
  if (!date) return null;
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  return /^\d{4}-\d{2}$/.test(month) ? month : null;
}

async function currentMonthVat(userId: string, english: boolean): Promise<{ text: string; sources: ChatSource[] } | null> {
  try {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const sources = await loadAlvPeriodSources(userId, start, end);
    const report = alvReportOf(sources);
    const month = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
    return formatBookedVatAnswer({
      month,
      amount: report.field308.amount.toFixed(2),
      isRefund: report.field308.isRefund,
      english,
    });
  } catch (error) {
    console.error("Chat VAT lookup failed:", error);
    return null;
  }
}

function entityPhrase(entityType: string | null | undefined, english: boolean): string {
  if (entityType === "oy") return english ? "As a limited company" : "Osakeyhtiönä";
  if (entityType === "kevytyrittaja") return english ? "As a light entrepreneur" : "Kevytyrittäjänä";
  return english ? "As a sole trader" : "Toiminimiyrittäjänä";
}

export async function prepareChat(
  userId: string,
  userMessage: string,
  prior: ContextTurn[] = []
): Promise<PreparedChat> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      entityType: true,
      vatRegistered: true,
      vatPeriod: true,
      businessDetails: true,
    },
  });

  const profile = parseBusinessDetails(user?.businessDetails);
  const profileSummary = generateProfileSummary(profile);

  const normalizedQuery = userMessage.toLowerCase().trim();
  const english = prefersEnglish(userMessage);

  if (isGreeting(userMessage)) {
    return { kind: "local", reply: greetingReply(english) };
  }

  const isMatchIntent = isMatchRequest(userMessage);

  if (isMatchIntent) {
    const unmatchedTxs = await prisma.transaction.findMany({
      where: {
        statement: { userId },
        matchStatus: { in: ["unmatched", "suggested"] },
        receiptId: null,
      },
      select: {
        id: true,
        date: true,
        counterparty: true,
        amountCents: true,
        reference: true,
        message: true,
        type: true,
      },
      orderBy: { date: "desc" },
      take: 20,
    });

    const openReceipts = await prisma.receipt.findMany({
      where: { userId, linkedTransaction: null, ...offerableReceiptWhere() },
      select: {
        id: true,
        vendor: true,
        date: true,
        totalAmountCents: true,
        type: true,
        reference: true,
        invoiceNumber: true,
        fileName: true,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    if (unmatchedTxs.length > 0 && openReceipts.length > 0) {
      const rejections = await prisma.matchRejection.findMany({
        where: { transaction: { statement: { userId } } },
        select: { transactionId: true, receiptId: true },
      });
      const rejectedPairs = new Set(
        rejections.map((r) => `${r.transactionId}:${r.receiptId}`)
      );

      const txModels: MatchTx[] = unmatchedTxs.map((t) => ({
        id: t.id,
        date: t.date,
        counterparty: t.counterparty,
        amount: centsToEuros(t.amountCents),
        reference: t.reference,
        message: t.message,
        type: t.type,
      }));

      const receiptModels: MatchReceipt[] = openReceipts.map((r) => ({
        id: r.id,
        vendor: r.vendor,
        date: r.date,
        totalAmount: r.totalAmountCents ? centsToEuros(r.totalAmountCents) : null,
        type: r.type,
        reference: r.reference,
        invoiceNumber: r.invoiceNumber,
      }));

      let bestProposal: ChatMatchProposal | undefined;
      let matchSources: ChatSource[] | undefined;
      let highestScore = 0;

      for (const tx of txModels) {
        const topCandidates = candidatesFor(tx, receiptModels, rejectedPairs, 1);
        if (topCandidates.length > 0 && topCandidates[0].score > highestScore) {
          highestScore = topCandidates[0].score;
          const candidate = topCandidates[0];
          const rawReceipt = openReceipts.find((r) => r.id === candidate.receiptId);
          const rawTx = unmatchedTxs.find((t) => t.id === candidate.transactionId);

          if (rawTx && rawReceipt) {
            const txDateStr = rawTx.date ? new Date(rawTx.date).toLocaleDateString("fi-FI") : "";
            const txVendor = rawTx.counterparty || rawTx.message || "Tuntematon siirto";
            const txAmt = centsToEuros(rawTx.amountCents).toFixed(2);

            const rVendor = rawReceipt.vendor || rawReceipt.fileName;
            const rAmt = rawReceipt.totalAmountCents
              ? centsToEuros(rawReceipt.totalAmountCents).toFixed(2)
              : "?";

            const txMonth = monthKey(rawTx.date);
            const receiptMonth = monthKey(rawReceipt.date);
            bestProposal = {
              type: "match_proposal",
              transactionId: rawTx.id,
              receiptId: rawReceipt.id,
              txSummary: `${txVendor} — ${txAmt} € (${txDateStr})`,
              receiptSummary: `${rVendor} — ${rAmt} € (${rawReceipt.fileName})`,
              confidenceScore: candidate.score,
              reasons: candidate.reasons,
            };
            const proposalSources: ChatSource[] = [];
            if (txMonth) proposalSources.push({ label: "Tiliotteet", href: statementDrillHref(txMonth) });
            if (receiptMonth) {
              proposalSources.push({
                label: "Kuitit",
                href: receiptDrillHref({ month: receiptMonth, type: rawReceipt.type === "tulo" ? "tulo" : "meno" }),
              });
            }
            matchSources = proposalSources;
          }
        }
      }

      if (bestProposal) {
        const amounts = [bestProposal.txSummary, bestProposal.receiptSummary]
          .flatMap((line) => [...line.matchAll(/(\d+\.\d{2})/g)].map((match) => match[1]));
        return {
          kind: "local",
          reply: english
            ? "I checked your bank rows and receipts and found one suggestion. Confirm it below. I have not linked them."
            : "Tarkistin pankkitapahtumasi ja kuitit. Löysin yhden ehdotuksen. Vahvista se alta. En ole vielä yhdistänyt niitä.",
          proposal: bestProposal,
          sources: matchSources,
          honesty: {
            performedActions: [],
            allowedAmounts: amounts,
            allowedRecordIds: [bestProposal.transactionId, bestProposal.receiptId],
            allowedHrefs: (matchSources ?? []).map((source) => source.href),
          },
        };
      }
      return {
        kind: "local",
        reply: english
          ? `No confident match among ${unmatchedTxs.length} open bank rows and ${openReceipts.length} receipts.`
          : `Avoimista pankkitapahtumista (${unmatchedTxs.length}) ja kuiteista (${openReceipts.length}) ei löytynyt varmaa ehdotusta.`,
      };
    }

    const totalTransactions =
      unmatchedTxs.length === 0
        ? await prisma.transaction.count({ where: { statement: { userId } } })
        : unmatchedTxs.length;
    return {
      kind: "local",
      reply:
        matchStatusReply({
          totalTransactions,
          unmatched: unmatchedTxs.length,
          openReceipts: openReceipts.length,
          english,
        }) ?? greetingReply(english),
    };
  }

  const asksVat = normalizedQuery.includes("alv") || normalizedQuery.includes("vero") || normalizedQuery.includes("vat");
  const asksDeduction =
    normalizedQuery.includes("kulut") ||
    normalizedQuery.includes("vähennys") ||
    normalizedQuery.includes("mitä voin") ||
    normalizedQuery.includes("deduct");
  const asksProfile = normalizedQuery.includes("profiili") || normalizedQuery.includes("yritysmuoto");
  const vatAnswer = asksVat ? await currentMonthVat(userId, english) : null;
  const vatLine = vatAnswer?.text ?? null;
  const who = entityPhrase(user?.entityType, english);

  // No model configured: answer what the books and the rules can answer, as
  // plain answers. Only a question nothing local can answer is `limited`, and
  // its reply says calmly what does work (OWN-09).
  if (!assistantAvailable()) {
    if (asksVat) {
      const reply = `${vatLine ?? ""}\n\n${
        english
          ? "Standard rate for lash services in 2026 is **25.5%**. See /kirjanpito/alv."
          : "Ripsipalveluiden yleinen ALV-kanta 2026 on **25,5 %**. Katso /kirjanpito/alv."
      }`.trim();
      return {
        kind: "local",
        reply,
        sources: mergeSources(vatAnswer?.sources, reply),
        honesty: {
          performedActions: [],
          allowedAmounts: vatAnswer ? [vatAnswer.text.match(/(\d+\.\d{2})/)?.[1] ?? ""].filter(Boolean) : [],
          allowedRecordIds: [],
          allowedHrefs: (vatAnswer?.sources ?? []).map((source) => source.href),
        },
      };
    }
    if (asksDeduction) {
      return {
        kind: "local",
        reply: `${who} ${
          english
            ? "you can deduct costs that belong to the business: materials, workspace, software, and training. Keep the receipt in Kuitit."
            : "voit vähentää yritystoimintaan kuuluvat kulut: tarvikkeet, työtila, ohjelmistot ja koulutus. Tallenna kuitti Kuitteihin."
        }`,
      };
    }
    if (asksProfile) {
      return {
        kind: "local",
        reply: profileSummary,
      };
    }
    return { kind: "local", limited: true, reply: limitedModeNotice(english) };
  }

  const systemPrompt = [
    english
      ? "You are LashKirja's bookkeeping assistant. Reply in the user's language, briefly."
      : "Olet LashKirjan kirjanpitoavustaja. Vastaa käyttäjän kielellä, lyhyesti.",
    "Do not dump the company profile unless the user asks about it.",
    "Separate information from actions. Do not claim you changed the books.",
    asksProfile ? `Profile: ${profileSummary}` : `Business form: ${who}.`,
    vatLine ? `Use this calculated figure, do not invent another: ${vatLine}` : "",
    "When you cite an amount from the books, name the screen (/kirjanpito/alv, /raportit, /kuitit, /laskut).",
    prior.length > 0 ? "Use the earlier turns. Answer the latest question." : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    kind: "provider",
    systemPrompt,
    userMessage,
    english,
    sources: vatAnswer?.sources,
    honesty: {
      performedActions: [],
      allowedAmounts: vatAnswer ? [vatAnswer.text.match(/(\d+\.\d{2})/)?.[1] ?? ""].filter(Boolean) : [],
      allowedRecordIds: [],
      allowedHrefs: (vatAnswer?.sources ?? []).map((source) => source.href),
    },
  };
}

export async function processAiChatMessage(
  userId: string,
  userMessage: string,
  prior: CopilotTurn[] = []
): Promise<ChatAssistantResult> {
  const prepared = await prepareChat(userId, userMessage, prior);
  if (prepared.kind === "local") {
    return {
      reply: prepared.reply,
      proposal: prepared.proposal,
      limited: prepared.limited,
      sources: prepared.sources,
    };
  }
  const token = process.env.COPILOT_GITHUB_TOKEN;
  if (!token) {
    return { reply: limitedModeNotice(prepared.english), limited: true, sources: prepared.sources };
  }
  try {
    const reply = await askCopilot(prepared.systemPrompt, prepared.userMessage, token, prior);
    if (!reply.trim()) {
      console.error("Copilot chat returned an empty reply");
      return { reply: providerFailedNotice(prepared.english), limited: true, sources: prepared.sources };
    }
    const guarded = enforceAssistantReply(reply, prepared.honesty ?? EMPTY_HONESTY);
    if (guarded.rejected) {
      return { reply: guarded.text, limited: true, sources: prepared.sources };
    }
    return { reply, sources: mergeSources(prepared.sources, reply) };
  } catch (error) {
    console.error("Copilot chat failed:", error);
    return { reply: providerFailedNotice(prepared.english), limited: true, sources: prepared.sources };
  }
}
