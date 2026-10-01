import { randomUUID } from "crypto";
import { guardWrite } from "@/lib/http-security";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { prepareChat, type ChatMatchProposal } from "@/lib/ai-assistant";
import { askCopilotStream } from "@/lib/copilot";
import { providerFailedNotice } from "@/lib/chat-policy";
import { displayChatContent } from "@/lib/chat-legacy";
import { errorText } from "@/lib/api-errors";
import { consumeRateLimit } from "@/lib/rate-limit";
import {
  CHAT_MESSAGE_MAX,
  CHAT_POST_LIMIT,
  CHAT_POST_WINDOW_MS,
  messageTooLong,
  type ChatSource,
} from "@/lib/chat-turn";
import {
  ChatBusyError,
  ChatConversationMissingError,
  createConversation,
  listConversationMessages,
  priorContextTurns,
  rememberConversationTitle,
  requireOpenConversation,
  runAssistantTurn,
} from "@/lib/chat-store";
import { ChatDecisionError, decideChatProposal } from "@/lib/chat-decision";

function parseSources(raw: string | null): ChatSource[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ChatSource[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapMessage(message: {
  id: string;
  role: string;
  content: string;
  clientId?: string | null;
  proposalData: string | null;
  sources?: string | null;
  status?: string;
  replyToId?: string | null;
  conversationId?: string;
  createdAt: Date;
}) {
  const raw = message.proposalData ? (JSON.parse(message.proposalData) as Record<string, unknown>) : null;
  const proposal = raw && raw.type === "match_proposal" ? raw : null;
  return {
    id: message.id,
    role: message.role,
    // Old replies can still start with the pre-OWN-09 "Rajattu tila" notice.
    content: displayChatContent(message.role, message.content),
    clientId: message.clientId ?? null,
    proposal,
    limited: Boolean(raw?.limited),
    sources: parseSources(message.sources ?? null),
    status: message.status ?? "complete",
    replyToId: message.replyToId ?? null,
    conversationId: message.conversationId ?? null,
    createdAt: message.createdAt,
  };
}

function proposalJson(proposal: ChatMatchProposal | undefined, limited: boolean | undefined): string | null {
  if (proposal) return JSON.stringify({ ...proposal, limited: Boolean(limited) });
  if (limited) return JSON.stringify({ limited: true });
  return null;
}

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const conversationId = req.nextUrl.searchParams.get("conversationId")?.trim() ?? "";
  const beforeRaw = req.nextUrl.searchParams.get("before");
  const beforeId = req.nextUrl.searchParams.get("beforeId")?.trim() ?? "";
  const before = beforeRaw ? new Date(beforeRaw) : null;
  if (beforeRaw && Number.isNaN(before?.getTime())) {
    return NextResponse.json({ error: "Virheellinen aikaleima" }, { status: 400 });
  }
  if ((beforeRaw && !beforeId) || (!beforeRaw && beforeId)) {
    return NextResponse.json({ error: "Sivutus tarvitsee ajan ja tunnisteen" }, { status: 400 });
  }

  const conversation = conversationId
    ? await prisma.conversation.findFirst({
        where: { id: conversationId, userId: session.userId, deletedAt: null },
      })
    : await prisma.conversation.findFirst({
        where: { userId: session.userId, deletedAt: null, archivedAt: null },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      });
  if (conversationId && !conversation) {
    return NextResponse.json({ error: "Keskustelua ei löydy" }, { status: 404 });
  }
  if (!conversation) {
    return NextResponse.json({ messages: [], hasMore: false, conversation: null });
  }

  const page = await listConversationMessages({
    userId: session.userId,
    conversationId: conversation.id,
    before: before && beforeId ? { createdAt: before, id: beforeId } : null,
  });

  return NextResponse.json({
    messages: page.rows.reverse().map(mapMessage),
    hasMore: page.hasMore,
    conversation: {
      id: conversation.id,
      title: conversation.title,
      archivedAt: conversation.archivedAt,
    },
  });
}

function sse(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    const requestedConversation = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    const stream = body.stream === true;
    if (!message) {
      return NextResponse.json({ error: "Viesti on pakollinen" }, { status: 400 });
    }
    if (messageTooLong(message)) {
      return NextResponse.json(
        { error: `Viesti on liian pitkä (enintään ${CHAT_MESSAGE_MAX} merkkiä).` },
        { status: 400 }
      );
    }
    const limit = consumeRateLimit(`chat-post:${session.userId}`, CHAT_POST_LIMIT, CHAT_POST_WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Liian monta viestiä. Odota hetki." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
      );
    }
    if (clientId && (clientId.length < 8 || clientId.length > 80)) {
      return NextResponse.json({ error: "Virheellinen viestin tunniste" }, { status: 400 });
    }

    const conversation = await (async () => {
      try {
        return requestedConversation
          ? await requireOpenConversation(session.userId, requestedConversation)
          : await createConversation(session.userId);
      } catch (error) {
        if (error instanceof ChatConversationMissingError) return null;
        throw error;
      }
    })();
    if (!conversation) {
      return NextResponse.json({ error: "Keskustelua ei löydy." }, { status: 404 });
    }
    if (conversation.archivedAt) {
      return NextResponse.json({ error: "Keskustelu on arkistoitu." }, { status: 409 });
    }

    let userRow = clientId
      ? await prisma.chatMessage.findFirst({
          where: { userId: session.userId, clientId },
        })
      : null;
    if (clientId && userRow && userRow.conversationId !== conversation.id) {
      return NextResponse.json({ error: "Viestin tunniste on jo käytössä" }, { status: 409 });
    }
    if (clientId && userRow && userRow.content !== message) {
      return NextResponse.json({ error: "Viestin tunniste on jo käytössä" }, { status: 409 });
    }
    if (!userRow) {
      userRow = await prisma.chatMessage.create({
        data: {
          userId: session.userId,
          conversationId: conversation.id,
          role: "user",
          content: message,
          clientId: clientId || null,
          status: "complete",
        },
      });
      await rememberConversationTitle(conversation.id, session.userId, message);
    }

    const prior = await priorContextTurns(session.userId, conversation.id, {
      createdAt: userRow.createdAt,
      id: userRow.id,
    });
    const prepared = await prepareChat(session.userId, message, prior);
    const owner = randomUUID();

    if (prepared.kind === "local" || !stream) {
      let reply = prepared.kind === "local" ? prepared.reply : "";
      let proposal = prepared.kind === "local" ? prepared.proposal : undefined;
      let limited = prepared.kind === "local" ? prepared.limited : false;
      let sources = prepared.kind === "local" ? prepared.sources : prepared.sources;
      if (prepared.kind === "provider") {
        const finished = await import("@/lib/ai-assistant").then((mod) =>
          mod.processAiChatMessage(session.userId, message, prior)
        );
        reply = finished.reply;
        proposal = finished.proposal;
        limited = finished.limited;
        sources = finished.sources;
      }
      const result = await runAssistantTurn({
        userId: session.userId,
        conversationId: conversation.id,
        userMessageId: userRow.id,
        owner,
        signal: req.signal,
        local: {
          content: reply,
          proposalData: proposalJson(proposal, limited),
          sources,
          limited,
        },
      });
      const row = await prisma.chatMessage.findUnique({ where: { id: result.messageId } });
      const payload = row
        ? { ...mapMessage(row), conversationId: conversation.id }
        : { ...result, conversationId: conversation.id };
      if (!stream) return NextResponse.json(payload);
      const bodyStream = new ReadableStream({
        start(controller) {
          controller.enqueue(sse({ conversationId: conversation.id, userMessageId: userRow.id }));
          controller.enqueue(sse({ delta: reply }));
          controller.enqueue(
            sse({
              done: true,
              status: "complete",
              id: result.messageId,
              replyToId: userRow.id,
              content: reply,
              proposal: proposal ?? null,
              sources: sources ?? [],
              createdAt: row?.createdAt,
              limited: Boolean(limited),
              conversationId: conversation.id,
            })
          );
          controller.close();
        },
      });
      return new Response(bodyStream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      });
    }

    const token = process.env.COPILOT_GITHUB_TOKEN;
    const encoderStream = new ReadableStream({
      async start(controller) {
        controller.enqueue(sse({ conversationId: conversation.id, userMessageId: userRow.id }));
        try {
          const result = await runAssistantTurn({
            userId: session.userId,
            conversationId: conversation.id,
            userMessageId: userRow.id,
            owner,
            signal: req.signal,
            failureNotice: providerFailedNotice(prepared.english),
            honesty: prepared.honesty,
            onDelta: (delta) => controller.enqueue(sse({ delta })),
            stream: token
              ? (signal) => askCopilotStream(prepared.systemPrompt, prepared.userMessage, token, signal, prior)
              : async function* () {
                  throw new Error("provider missing");
                },
          });
          const row = await prisma.chatMessage.findUnique({ where: { id: result.messageId } });
          const mapped = row ? mapMessage(row) : null;
          if (result.replay && mapped) controller.enqueue(sse({ delta: mapped.content }));
          controller.enqueue(
            sse({
              done: result.status === "complete",
              incomplete: result.status !== "complete",
              status: result.status,
              id: result.messageId,
              replyToId: userRow.id,
              content: mapped?.content ?? result.content,
              proposal: mapped?.proposal ?? null,
              sources: mapped?.sources ?? [],
              createdAt: row?.createdAt,
              limited: mapped?.limited ?? result.status === "failed",
              conversationId: conversation.id,
              error: result.status === "complete" ? undefined : mapped?.content,
            })
          );
        } catch (error) {
          if (error instanceof ChatBusyError) {
            controller.enqueue(sse({ incomplete: true, status: "busy", error: error.message }));
            return;
          }
          console.error("Copilot stream failed:", errorText(error));
          controller.enqueue(
            sse({
              incomplete: true,
              status: "failed",
              error: providerFailedNotice(prepared.english),
            })
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(encoderStream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  } catch (error: unknown) {
    if (error instanceof ChatBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("AI Chat API Error:", errorText(error));
    return NextResponse.json(
      { error: "Avustaja ei saanut vastausta valmiiksi. Yritä hetken kuluttua uudelleen." },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const id = body && typeof body.id === "string" ? body.id : "";
  const decision = body && (body.decision === "accepted" || body.decision === "rejected") ? body.decision : null;
  if (!id || !decision) {
    return NextResponse.json({ error: "Päätös puuttuu" }, { status: 400 });
  }
  try {
    const updated = await decideChatProposal({ userId: session.userId, messageId: id, decision });
    if (!updated) return NextResponse.json({ error: "Viestiä ei löydy" }, { status: 404 });
    return NextResponse.json(mapMessage(updated));
  } catch (error) {
    if (error instanceof ChatDecisionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Chat decision failed:", errorText(error));
    return NextResponse.json({ error: "Päätöksen tallennus epäonnistui" }, { status: 500 });
  }
}
