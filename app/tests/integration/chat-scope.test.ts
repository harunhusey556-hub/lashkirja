import { afterEach, beforeEach, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { prepareChat } from "@/lib/ai-assistant";
import { runAssistantTurn } from "@/lib/chat-store";
import { scopeRefusal } from "@/lib/chat-scope";
import { createUser, resetDatabase } from "./helpers/factories";

const savedToken = process.env.COPILOT_GITHUB_TOKEN;

beforeEach(async () => {
  await resetDatabase();
  // A configured provider, so prepareChat takes the model path (nothing is called here).
  process.env.COPILOT_GITHUB_TOKEN = "test-token";
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
  else process.env.COPILOT_GITHUB_TOKEN = savedToken;
});

it("answers a request for code itself, without asking the model", async () => {
  const user = await createUser();
  const result = await prepareChat(user.id, "html kod yaz");
  expect(result.kind).toBe("local");
  if (result.kind === "local") expect(result.reply).toBe(scopeRefusal("tr"));
});

it("still sends a bookkeeping question to the model, with the scope rule", async () => {
  const user = await createUser();
  const result = await prepareChat(user.id, "Kirjoita lasku asiakkaalle Anna, miten se tehdään?");
  expect(result.kind).toBe("provider");
  if (result.kind === "provider") expect(result.systemPrompt).toContain("Never output code");
});

it("does not store or show a streamed reply that turned into code", async () => {
  const user = await createUser();
  const conversation = await prisma.conversation.create({ data: { userId: user.id } });
  const question = await prisma.chatMessage.create({
    data: { userId: user.id, conversationId: conversation.id, role: "user", content: "Miten kirjaan kuitin?" },
  });
  const prepared = await prepareChat(user.id, "Miten kirjaan kuitin?");
  expect(prepared.kind).toBe("provider");
  const result = await runAssistantTurn({
    userId: user.id,
    conversationId: conversation.id,
    userMessageId: question.id,
    owner: "test-scope",
    signal: new AbortController().signal,
    honesty: prepared.kind === "provider" ? prepared.honesty : undefined,
    stream: async function* () {
      yield "Tässä sivu:\n```html\n<div>kuitti</div>\n```";
    },
  });
  const stored = await prisma.chatMessage.findUniqueOrThrow({ where: { id: result.messageId } });
  expect(stored.content).toBe(scopeRefusal("fi"));
});
