import { prisma } from "./db";
import { parseBusinessDetails, generateProfileSummary } from "./onboarding";
import { centsToEuros } from "./money";
import { candidatesFor, MatchTx, MatchReceipt } from "./matching";
import { askCopilot } from "./copilot";

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
}

export async function processAiChatMessage(
  userId: string,
  userMessage: string
): Promise<ChatAssistantResult> {
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
  const isMatchIntent =
    normalizedQuery.includes("täsmäytä") ||
    normalizedQuery.includes("match") ||
    normalizedQuery.includes("kuitti") ||
    normalizedQuery.includes("yhdistä") ||
    normalizedQuery.includes("lasku") ||
    normalizedQuery.includes("ehdotus");

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
      where: { userId, linkedTransaction: null },
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

            bestProposal = {
              type: "match_proposal",
              transactionId: rawTx.id,
              receiptId: rawReceipt.id,
              txSummary: `${txVendor} — ${txAmt} € (${txDateStr})`,
              receiptSummary: `${rVendor} — ${rAmt} € (${rawReceipt.fileName})`,
              confidenceScore: candidate.score,
              reasons: candidate.reasons,
            };
          }
        }
      }

      if (bestProposal) {
        return {
          reply: `Tarkistin pankkitapahtumasi ja kuitit! Löysin yhteensopivan ehdotuksen. Tarkista ja hyväksy yhdistäminen alta:`,
          proposal: bestProposal,
        };
      } else {
        return {
          reply: `Ajoin täsmäytystarkistuksen. Juuri nyt avoimille pankkitapahtumillesi (${unmatchedTxs.length} kpl) ja kuiteillesi (${openReceipts.length} kpl) ei löytynyt varmoja ehdotuksia. Voit lisätä uusia kuitteja Kuitit-sivulta!`,
        };
      }
    } else if (unmatchedTxs.length === 0) {
      return {
        reply: `Kaikki tiliotteesi tapahtumat on jo täsmäytetty kuitteihin! Hienoa työtä! 🎉`,
      };
    } else {
      return {
        reply: `Sinulla on ${unmatchedTxs.length} täsmäyttämätöntä pankkitapahtumaa, mutta ei vielä liitettyjä kuitteja. Lataa kuitti Kuitit-sivulta niin voin auttaa yhdistämisessä!`,
      };
    }
  }

  // General bookkeeping assistant replies based on Finnish sole trader & lash business domain
  const ghToken = process.env.COPILOT_GITHUB_TOKEN;
  if (ghToken) {
    try {
      const systemPrompt = `Olet ystävällinen ja asiantunteva kirjanpidon apulainen (LashKirja AI).
Käyttäjän profiili: ${profileSummary}
Autat suomalaista yrittäjää kirjanpidon, ALV-vähennysten ja kuitteihin liittyvissä kysymyksissä.
Vastaa lyhyesti, selkeästi ja kannustavasti suomeksi. Käytä tarvittaessa luetteloita.`;
      
      const reply = await askCopilot(systemPrompt, userMessage, ghToken);
      return { reply };
    } catch (error) {
      console.error("Copilot chat failed:", error);
      // Fallback to static rules below
    }
  }

  if (normalizedQuery.includes("alv") || normalizedQuery.includes("vero")) {
    return {
      reply: `Suomen ALV-järjestelmässä (2026):
• Ripsienpidennykset ja kulmapalvelut: **25,5 %** (yleinen ALV-kanta)
• Kauneus- ja ihonhoitotuotteiden jälleenmyynti: **25,5 %**
• Koulutus: yleensä **25,5 %** (ellei kyseessä ole virallinen tutkintokoulutus)
• ALV-raportin näet LashKirjan **ALV-sivulta**, mistä voit siirtää summat suoraan OmaVeroon.`,
    };
  }

  if (
    normalizedQuery.includes("kulut") ||
    normalizedQuery.includes("vähennys") ||
    normalizedQuery.includes("mitä voin")
  ) {
    return {
      reply: `Toiminimiyrittäjänä voit vähentää verotuksessa kaikki yritystoimintaan liittyvät kulut:
1. **Ripsiliimat, kuidut, nesteet ja suojatarvikkeet** (ALV 25,5%)
2. **Liiketilan vuokra tai hoitolapaikkavuokra**
3. **Ajanvarausohjelmat, kirjanpito-ohjelmat ja markkinointikulut**
4. **Työvaatteet** (jos yksinomaan työkäyttöön tarkoitetut)
5. **Koulutus- ja kurssimaksut** alan ammattitaidon ylläpitämiseen.

Muista aina ottaa kuitti talteen LashKirjaan!`,
    };
  }

  return {
    reply: `Hei! Olen tekoälyapurisi. Suorittamiesi asetusten pohjalta (${profileSummary}):
Voin auttaa sinua täsmäyttämään tiliotteen tapahtumia kuiteiksi, laskemaan ALV:t tai vastaamaan kirjanpitokysymyksiin.

Kokeile kysyä esimerkiksi:
• *"Täsmäytä tiliotteen kuitit"*
• *"Mikä on ripsipalveluiden ALV-prosentti?"*
• *"Mitä kuluja toiminimiyrittäjä voi vähentää?"*`,
  };
}
