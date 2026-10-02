import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { prepareChat } from "@/lib/ai-assistant";
import { runAssistantTurn } from "@/lib/chat-store";
import { createUser, createReceipt, resetDatabase } from "./helpers/factories";

beforeEach(async () => { await resetDatabase(); vi.stubEnv("LLM_API_KEY", "test-no-network"); });
afterEach(() => vi.unstubAllEnvs());

it("loads only authenticated user context and never password hashes", async () => {
  const owner = await createUser({ firstName: "OwnerContext" });
  const stranger = await createUser({ firstName: "StrangerSecret" });
  const own = await createReceipt(owner.id, { vendor: "OwnVendor", totalAmountCents: 1234 });
  await createReceipt(stranger.id, { vendor: "PrivateOtherVendor", totalAmountCents: 99999 });
  const prepared = await prepareChat(owner.id, "Tell me about my receipts and business");
  expect(prepared.kind).toBe("provider");
  if (prepared.kind !== "provider") throw new Error("Expected context");
  expect(prepared.systemPrompt).toContain("OwnerContext");
  expect(prepared.systemPrompt).toContain("OwnVendor");
  expect(prepared.systemPrompt).not.toContain("PrivateOtherVendor");
  expect(prepared.systemPrompt).not.toContain("passwordHash");
  expect(prepared.honesty.allowedAmounts).toContain("12.34");
  expect(prepared.honesty.allowedRecordIds).toContain(own.id);
});

it("keeps server action chips in streamed messages and stored history", async () => {
  const user = await createUser();
  const conversation = await prisma.conversation.create({ data: { userId: user.id } });
  const question = await prisma.chatMessage.create({ data: { userId: user.id, conversationId: conversation.id, role: "user", content: "Where are settings?" } });
  const sources = [{ label: "Asetukset", href: "/asetukset", kind: "action" as const }];
  const result = await runAssistantTurn({ userId: user.id, conversationId: conversation.id, userMessageId: question.id, owner: "test-stream", signal: new AbortController().signal, sources, stream: async function* () { yield "Open settings below."; } });
  expect(JSON.parse(result.sources!)).toEqual(sources);
  const stored = await prisma.chatMessage.findUniqueOrThrow({ where: { id: result.messageId } });
  expect(JSON.parse(stored.sources!)).toEqual(sources);
});

it("returns a bank action without a provider call", async () => {
  const user = await createUser();
  const result = await prepareChat(user.id, "Bankamı nereden bağlayabilirim?");
  expect(result.kind).toBe("local");
  expect(result.sources?.[0]).toMatchObject({ href: "/kirjanpito/pankkitilit?connect=1", kind: "action" });
});
