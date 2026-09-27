import { prisma } from "./db";
import { mergeSources } from "./chat-honesty";
import {
  CHAT_PAGE_SIZE,
  DEFAULT_CONVERSATION_TITLE,
  ownerIsFresh,
  settleChatStream,
  streamEndReason,
  titleFromMessage,
  type ChatSource,
  type ChatTurnStatus,
  type ContextTurn,
} from "./chat-turn";

export class ChatBusyError extends Error {
  constructor() {
    super("Vastaus on jo tekeillä.");
    this.name = "ChatBusyError";
  }
}

export class ChatConversationMissingError extends Error {
  constructor() {
    super("Keskustelua ei löydy.");
    this.name = "ChatConversationMissingError";
  }
}

function isUniqueConflict(error: unknown): boolean {
  return (error as { code?: string }).code === "P2002";
}

export async function createConversation(userId: string, title = DEFAULT_CONVERSATION_TITLE) {
  return prisma.conversation.create({
    data: { userId, title },
  });
}

export async function requireOpenConversation(userId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId, deletedAt: null },
  });
  if (!conversation) throw new ChatConversationMissingError();
  return conversation;
}

export async function listConversations(input: {
  userId: string;
  query?: string;
  archived?: boolean;
}) {
  const query = input.query?.trim();
  return prisma.conversation.findMany({
    where: {
      userId: input.userId,
      deletedAt: null,
      archivedAt: input.archived ? { not: null } : null,
      ...(query
        ? {
            OR: [
              { title: { contains: query } },
              { messages: { some: { content: { contains: query } } } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 50,
    select: {
      id: true,
      title: true,
      archivedAt: true,
      updatedAt: true,
      createdAt: true,
    },
  });
}

export async function updateConversation(
  userId: string,
  id: string,
  patch: { title?: string; archived?: boolean; deleted?: boolean }
) {
  const existing = await prisma.conversation.findFirst({
    where: { id, userId },
  });
  if (!existing) return null;
  return prisma.conversation.update({
    where: { id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title.trim() || DEFAULT_CONVERSATION_TITLE } : {}),
      ...(patch.archived === true ? { archivedAt: existing.archivedAt ?? new Date() } : {}),
      ...(patch.archived === false ? { archivedAt: null } : {}),
      ...(patch.deleted === true ? { deletedAt: new Date() } : {}),
      ...(patch.deleted === false ? { deletedAt: null } : {}),
    },
  });
}

export async function listConversationMessages(input: {
  userId: string;
  conversationId: string;
  before?: { createdAt: Date; id: string } | null;
  take?: number;
}) {
  const take = input.take ?? CHAT_PAGE_SIZE;
  const rows = await prisma.chatMessage.findMany({
    where: {
      userId: input.userId,
      conversationId: input.conversationId,
      ...(input.before
        ? {
            OR: [
              { createdAt: { lt: input.before.createdAt } },
              { AND: [{ createdAt: input.before.createdAt }, { id: { lt: input.before.id } }] },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
  });
  const hasMore = rows.length > take;
  return { rows: rows.slice(0, take), hasMore };
}

export async function priorContextTurns(
  userId: string,
  conversationId: string,
  before: { createdAt: Date; id: string }
): Promise<ContextTurn[]> {
  const rows = await prisma.chatMessage.findMany({
    where: {
      userId,
      conversationId,
      status: "complete",
      content: { not: "" },
      OR: [
        { createdAt: { lt: before.createdAt } },
        { AND: [{ createdAt: before.createdAt }, { id: { lt: before.id } }] },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 12,
    select: { role: true, content: true },
  });
  return rows
    .reverse()
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({ role: row.role as "user" | "assistant", content: row.content }));
}

export type ClaimResult =
  | { kind: "owned"; messageId: string }
  | { kind: "done"; messageId: string; content: string; proposalData: string | null; sources: string | null }
  | { kind: "busy" };

async function reclaim(
  row: {
    id: string;
    status: string;
    content: string;
    proposalData: string | null;
    sources: string | null;
    replyOwner: string | null;
    ownerHeartbeat: Date | null;
  },
  owner: string,
  now: Date
): Promise<ClaimResult> {
  if (row.status === "complete") {
    return {
      kind: "done",
      messageId: row.id,
      content: row.content,
      proposalData: row.proposalData,
      sources: row.sources,
    };
  }
  if (row.status === "streaming" && row.replyOwner && row.replyOwner !== owner && ownerIsFresh(row.ownerHeartbeat, now)) {
    return { kind: "busy" };
  }
  return prisma.$transaction(async (tx) => {
    const current = await tx.chatMessage.findUnique({ where: { id: row.id } });
    if (!current) return { kind: "busy" } as ClaimResult;
    if (current.status === "complete") {
      return {
        kind: "done",
        messageId: current.id,
        content: current.content,
        proposalData: current.proposalData,
        sources: current.sources,
      } as ClaimResult;
    }
    if (
      current.status === "streaming" &&
      current.replyOwner &&
      current.replyOwner !== owner &&
      ownerIsFresh(current.ownerHeartbeat, now)
    ) {
      return { kind: "busy" } as ClaimResult;
    }
    const updated = await tx.chatMessage.updateMany({
      where: {
        id: current.id,
        status: current.status,
        replyOwner: current.replyOwner,
      },
      data: {
        replyOwner: owner,
        ownerHeartbeat: now,
        status: "streaming",
        content: "",
        proposalData: null,
        sources: null,
      },
    });
    if (updated.count !== 1) return { kind: "busy" } as ClaimResult;
    return { kind: "owned", messageId: current.id } as ClaimResult;
  });
}

/** One assistant row per user message. A live owner blocks a second retry. */
export async function claimAssistantReply(input: {
  userId: string;
  conversationId: string;
  userMessageId: string;
  owner: string;
  now?: Date;
}): Promise<ClaimResult> {
  const now = input.now ?? new Date();
  const existing = await prisma.chatMessage.findFirst({
    where: { replyToId: input.userMessageId, userId: input.userId },
  });
  if (existing) return reclaim(existing, input.owner, now);
  try {
    const created = await prisma.chatMessage.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId,
        role: "assistant",
        content: "",
        replyToId: input.userMessageId,
        status: "streaming",
        replyOwner: input.owner,
        ownerHeartbeat: now,
      },
    });
    return { kind: "owned", messageId: created.id };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const row = await prisma.chatMessage.findFirst({
      where: { replyToId: input.userMessageId, userId: input.userId },
    });
    if (!row) throw error;
    return reclaim(row, input.owner, now);
  }
}

export async function touchReplyOwner(messageId: string, owner: string, now = new Date()) {
  await prisma.chatMessage.updateMany({
    where: { id: messageId, replyOwner: owner },
    data: { ownerHeartbeat: now },
  });
}

export async function finishAssistantReply(input: {
  messageId: string;
  owner: string;
  content: string;
  status: ChatTurnStatus;
  proposalData?: string | null;
  sources?: ChatSource[] | null;
  limited?: boolean;
}): Promise<boolean> {
  const proposal =
    input.proposalData != null
      ? input.proposalData
      : input.limited
        ? JSON.stringify({ limited: true })
        : null;
  const sources =
    input.sources && input.sources.length > 0 ? JSON.stringify(input.sources) : null;
  const updated = await prisma.chatMessage.updateMany({
    where: { id: input.messageId, replyOwner: input.owner },
    data: {
      content: input.content,
      status: input.status,
      proposalData: proposal,
      sources,
      replyOwner: null,
      ownerHeartbeat: null,
    },
  });
  return updated.count === 1;
}

async function readTurn(messageId: string) {
  const row = await prisma.chatMessage.findUnique({ where: { id: messageId } });
  if (!row) return null;
  return row;
}

export async function runAssistantTurn(input: {
  userId: string;
  conversationId: string;
  userMessageId: string;
  owner: string;
  signal: AbortSignal;
  timeoutMs?: number;
  local?: { content: string; proposalData?: string | null; sources?: ChatSource[]; limited?: boolean };
  failureNotice?: string;
  stream?: (signal: AbortSignal) => AsyncGenerator<string>;
  onDelta?: (delta: string) => void;
}): Promise<{
  messageId: string;
  status: ChatTurnStatus;
  content: string;
  proposalData: string | null;
  sources: string | null;
  replay: boolean;
  lostOwnership: boolean;
}> {
  const claim = await claimAssistantReply({
    userId: input.userId,
    conversationId: input.conversationId,
    userMessageId: input.userMessageId,
    owner: input.owner,
  });
  if (claim.kind === "busy") throw new ChatBusyError();
  if (claim.kind === "done") {
    return {
      messageId: claim.messageId,
      status: "complete",
      content: claim.content,
      proposalData: claim.proposalData,
      sources: claim.sources,
      replay: true,
      lostOwnership: false,
    };
  }

  if (input.local) {
    const sources = mergeSources(input.local.sources, input.local.content);
    const saved = await finishAssistantReply({
      messageId: claim.messageId,
      owner: input.owner,
      content: input.local.content,
      status: "complete",
      proposalData: input.local.proposalData ?? null,
      sources,
      limited: input.local.limited,
    });
    const row = await readTurn(claim.messageId);
    return {
      messageId: claim.messageId,
      status: "complete",
      content: row?.content ?? input.local.content,
      proposalData: row?.proposalData ?? null,
      sources: row?.sources ?? null,
      replay: false,
      lostOwnership: !saved,
    };
  }

  const timeoutMs = input.timeoutMs ?? 30_000;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort("timeout"), timeoutMs);
  const signal = AbortSignal.any([input.signal, timeout.signal]);
  let collected = "";
  let deltas = 0;
  let threw = false;
  try {
    if (!input.stream) throw new Error("stream missing");
    const iterator = input.stream(signal)[Symbol.asyncIterator]();
    try {
      while (!signal.aborted) {
        const next = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        ]);
        if (next.done) break;
        collected += next.value;
        deltas += 1;
        input.onDelta?.(next.value);
        if (deltas % 8 === 0) await touchReplyOwner(claim.messageId, input.owner);
      }
    } finally {
      await iterator.return?.(undefined);
    }
  } catch {
    threw = !signal.aborted;
  } finally {
    clearTimeout(timer);
  }

  const timedOut = timeout.signal.aborted;
  const reason = streamEndReason({ signal: input.signal, timedOut, threw: threw && !timedOut });
  const settled = settleChatStream({ reason, collected });
  let content = settled.content;
  let limited = false;
  if (settled.status === "failed" && !collected.trim() && input.failureNotice) {
    content = input.failureNotice;
    limited = true;
  }
  const sources = mergeSources(undefined, content);
  const saved = await finishAssistantReply({
    messageId: claim.messageId,
    owner: input.owner,
    content,
    status: settled.status,
    sources,
    limited,
  });
  const row = await readTurn(claim.messageId);
  return {
    messageId: claim.messageId,
    status: (row?.status as ChatTurnStatus) ?? settled.status,
    content: row?.content ?? content,
    proposalData: row?.proposalData ?? (limited ? JSON.stringify({ limited: true }) : null),
    sources: row?.sources ?? null,
    replay: false,
    lostOwnership: !saved,
  };
}

export async function rememberConversationTitle(conversationId: string, userId: string, message: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { title: true },
  });
  const title =
    !conversation || conversation.title === DEFAULT_CONVERSATION_TITLE
      ? titleFromMessage(message)
      : undefined;
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date(), ...(title ? { title } : {}) },
  });
}
