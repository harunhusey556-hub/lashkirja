import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { alvReportOf, loadAlvPeriodSources } from "@/lib/alv-period";
import { alvPeriodBoundsUtc, helsinkiMonthKey, helsinkiQuarterKey } from "@/lib/validation";
import { EMPTY_HONESTY, HONESTY_REFUSAL, replyUsesCalculatedAmount } from "@/lib/chat-honesty";
import { runAssistantTurn } from "@/lib/chat-store";
import { GuardedReplyStream } from "@/lib/chat-stream-gate";
import { POST as postChat } from "@/app/api/ai/chat/route";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  delete process.env.COPILOT_GITHUB_TOKEN;
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function ask(message: string) {
  const response = await postChat(buildRequest("POST", "/api/ai/chat", { message, clientId: crypto.randomUUID() }, { cookie }));
  return readJson<{ content: string; limited: boolean; sources: { label: string; href: string }[] }>(response);
}

async function bookedVat(key: string): Promise<string> {
  const { start, end } = alvPeriodBoundsUtc(key);
  return alvReportOf(await loadAlvPeriodSources(user.id, start, end)).field308.amount.toFixed(2);
}

function previousMonthKey(): string {
  const [year, month] = helsinkiMonthKey().split("-").map(Number);
  const total = year * 12 + month - 2;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

describe("A1: the VAT of the period the question asks about", () => {
  beforeEach(async () => {
    const thisMonth = helsinkiMonthKey();
    await createReceipt(user.id, { type: "tulo", date: `${previousMonthKey()}-10`, totalAmountCents: 12_550, vatDetails: JSON.stringify([{ rate: 25.5, amount: 25.5 }]), vendor: "Asiakas A" });
    await createReceipt(user.id, { type: "tulo", date: `${thisMonth}-01`, totalAmountCents: 5_020, vatDetails: JSON.stringify([{ rate: 25.5, amount: 10.2 }]), vendor: "Asiakas B" });
  });

  it("answers last month's VAT for last month, and names it", async () => {
    const key = previousMonthKey();
    const expected = await bookedVat(key);
    expect(expected).not.toBe(await bookedVat(helsinkiMonthKey()));
    for (const question of ["Paljonko oli viime kuun ALV?", "Edellisen kuun ALV?", "Geçen ay KDV ne kadar?"]) {
      const reply = await ask(question);
      expect(reply.limited, question).toBe(false);
      expect(replyUsesCalculatedAmount(reply.content, expected), `${question}: ${reply.content}`).toBe(true);
      expect(reply.sources[0].href).toBe(`/kirjanpito/alv?period=${key}`);
    }
  });

  it("answers this month's VAT for a Turkish question, in Turkish", async () => {
    const key = helsinkiMonthKey();
    const reply = await ask("Bu ay KDV ne kadar?");
    expect(reply.limited).toBe(false);
    expect(reply.content).toMatch(/KDV: (ödenecek|iade edilecek)/);
    expect(replyUsesCalculatedAmount(reply.content, await bookedVat(key))).toBe(true);
    expect(reply.sources[0].href).toBe(`/kirjanpito/alv?period=${key}`);
  });

  it("follows the owner's quarterly VAT period when no period is named", async () => {
    await prisma.user.update({ where: { id: user.id }, data: { vatPeriod: "quarter" } });
    const key = helsinkiQuarterKey();
    const reply = await ask("Paljonko ALV:ia maksan?");
    expect(reply.sources[0].href).toBe(`/kirjanpito/alv?period=${key}`);
    expect(replyUsesCalculatedAmount(reply.content, await bookedVat(key))).toBe(true);
    // A month asked by a quarterly filer names the return it belongs to.
    const month = await ask("Viime kuun ALV?");
    expect(month.content).toMatch(/ALV-kautesi on neljännesvuosi/);
  });
});

describe("A3: a streamed figure is not shown before the guard", () => {
  async function streamTurn(pieces: string[], allowedAmounts: string[]) {
    const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "Stream" } });
    const question = await prisma.chatMessage.create({
      data: { userId: user.id, conversationId: conversation.id, role: "user", content: "ALV?", status: "complete" },
    });
    const gate = new GuardedReplyStream();
    const deltas: string[] = [];
    const result = await runAssistantTurn({
      userId: user.id,
      conversationId: conversation.id,
      userMessageId: question.id,
      owner: "gate",
      signal: new AbortController().signal,
      honesty: { ...EMPTY_HONESTY, allowedAmounts },
      onDelta: (delta) => {
        const visible = gate.push(delta);
        if (visible) deltas.push(visible);
      },
      stream: async function* () {
        for (const piece of pieces) yield piece;
      },
    });
    return { result, streamed: deltas.join(""), rest: gate.finish(result) };
  }

  it("holds a wrong figure and sends only the correction", async () => {
    const { result, streamed, rest } = await streamTurn(["Tarkistin kirjanpidon. ", "ALV on 999", " EUR."], []);
    expect(streamed).toBe("Tarkistin kirjanpidon. ");
    expect(streamed).not.toMatch(/999/);
    expect(result.content).toBe(HONESTY_REFUSAL);
    expect(rest).toBe("");
  });

  it("sends a verified figure after the guard passes, in order", async () => {
    const { result, streamed, rest } = await streamTurn(["Tarkistin kirjanpidon. ", "ALV on 287,01 €.", " Kerro jos tarvitset muuta."], ["287.01"]);
    expect(streamed).toBe("Tarkistin kirjanpidon. ");
    expect(result.status).toBe("complete");
    expect(streamed + rest).toBe(result.content);
  });
});
