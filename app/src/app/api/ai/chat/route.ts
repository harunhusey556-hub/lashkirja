import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { prepareChat, type ChatMatchProposal } from "@/lib/ai-assistant";
import { askCopilotStream } from "@/lib/copilot";
import { limitedModeNotice } from "@/lib/chat-policy";
import { errorText } from "@/lib/api-errors";

const PAGE_SIZE = 50;

function mapMessage(message: {
  id: string;
  role: string;
  content: string;
  clientId?: string | null;
  proposalData: string | null;
  createdAt: Date;
}) {
  const raw = message.proposalData ? (JSON.parse(message.proposalData) as Record<string, unknown>) : null;
  const proposal = raw && raw.type === "match_proposal" ? raw : null;
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    clientId: message.clientId ?? null,
    proposal,
    limited: Boolean(raw?.limited),
    createdAt: message.createdAt,
  };
}

export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const beforeRaw = req.nextUrl.searchParams.get("before");
  const before = beforeRaw ? new Date(beforeRaw) : null;
  if (beforeRaw && Number.isNaN(before?.getTime())) {
    return NextResponse.json({ error: "Virheellinen aikaleima" }, { status: 400 });
  }

  const rows = await prisma.chatMessage.findMany({
    where: {
      userId: session.userId,
      ...(before ? { createdAt: { lt: before } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE,
  });

  return NextResponse.json({
    messages: rows.reverse().map(mapMessage),
    hasMore: rows.length === PAGE_SIZE,
  });
}

function sse(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

async function savedAssistant(
  userId: string,
  reply: string,
  proposal: ChatMatchProposal | undefined,
  limited: boolean | undefined
) {
  return prisma.chatMessage.create({
    data: {
      userId,
      role: "assistant",
      content: reply,
      proposalData: proposal
        ? JSON.stringify({ ...proposal, limited: Boolean(limited) })
        : limited
          ? JSON.stringify({ limited: true })
          : null,
    },
  });
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    const stream = body.stream === true;
    if (!message) {
      return NextResponse.json({ error: "Viesti on pakollinen" }, { status: 400 });
    }
    if (clientId && (clientId.length < 8 || clientId.length > 80)) {
      return NextResponse.json({ error: "Virheellinen viestin tunniste" }, { status: 400 });
    }

    let userRow = clientId
      ? await prisma.chatMessage.findFirst({ where: { userId: session.userId, clientId } })
      : null;
    if (clientId && userRow && userRow.content !== message) {
      return NextResponse.json({ error: "Viestin tunniste on jo käytössä" }, { status: 409 });
    }
    if (!userRow) {
      userRow = await prisma.chatMessage.create({
        data: {
          userId: session.userId,
          role: "user",
          content: message,
          clientId: clientId || null,
        },
      });
    }

    const following = await prisma.chatMessage.findFirst({
      where: {
        userId: session.userId,
        id: { not: userRow.id },
        createdAt: { gte: userRow.createdAt },
      },
      orderBy: { createdAt: "asc" },
    });
    const existingAssistant = following?.role === "assistant" ? following : null;
    if (existingAssistant) {
      const mapped = mapMessage(existingAssistant);
      if (!stream) return NextResponse.json(mapped);
      const replay = new ReadableStream({
        start(controller) {
          controller.enqueue(sse({ delta: mapped.content }));
          controller.enqueue(
            sse({
              done: true,
              id: mapped.id,
              content: mapped.content,
              proposal: mapped.proposal,
              createdAt: mapped.createdAt,
              limited: mapped.limited,
            })
          );
          controller.close();
        },
      });
      return new Response(replay, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      });
    }

    const prepared = await prepareChat(session.userId, message);

    if (prepared.kind === "local" || !stream) {
      let reply = prepared.kind === "local" ? prepared.reply : "";
      let proposal = prepared.kind === "local" ? prepared.proposal : undefined;
      let limited = prepared.kind === "local" ? prepared.limited : false;
      if (prepared.kind === "provider") {
        const finished = await import("@/lib/ai-assistant").then((mod) =>
          mod.processAiChatMessage(session.userId, message)
        );
        reply = finished.reply;
        proposal = finished.proposal;
        limited = finished.limited;
      }
      const assistantMsg = await savedAssistant(session.userId, reply, proposal, limited);
      const payload = {
        ...mapMessage(assistantMsg),
        proposal: proposal ?? null,
        limited: Boolean(limited),
      };
      if (!stream) return NextResponse.json(payload);
      const bodyStream = new ReadableStream({
        start(controller) {
          controller.enqueue(sse({ delta: reply }));
          controller.enqueue(
            sse({
              done: true,
              id: assistantMsg.id,
              content: reply,
              proposal: proposal ?? null,
              createdAt: assistantMsg.createdAt,
              limited: Boolean(limited),
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
        let collected = "";
        let finished = false;
        try {
          if (!token) throw new Error("provider missing");
          for await (const delta of askCopilotStream(
            prepared.systemPrompt,
            prepared.userMessage,
            token,
            req.signal
          )) {
            collected += delta;
            controller.enqueue(sse({ delta }));
          }
          if (!collected.trim()) throw new Error("empty provider stream");
          const assistantMsg = await savedAssistant(session.userId, collected, undefined, false);
          finished = true;
          controller.enqueue(
            sse({
              done: true,
              id: assistantMsg.id,
              content: collected,
              proposal: null,
              createdAt: assistantMsg.createdAt,
              limited: false,
            })
          );
        } catch (error) {
          console.error("Copilot stream failed:", errorText(error));
          if (!finished) {
            const notice = limitedModeNotice(prepared.english);
            const assistantMsg = collected
              ? null
              : await savedAssistant(session.userId, notice, undefined, true);
            controller.enqueue(
              sse({
                incomplete: true,
                error: notice,
                id: assistantMsg?.id,
                content: collected,
              })
            );
          }
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
    console.error("AI Chat API Error:", errorText(error));
    return NextResponse.json(
      { error: "Tekoälyapurin käsittely epäonnistui. Yritä hetken kuluttua uudelleen." },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const id = body && typeof body.id === "string" ? body.id : "";
  const decision = body && (body.decision === "accepted" || body.decision === "rejected") ? body.decision : null;
  if (!id || !decision) {
    return NextResponse.json({ error: "Päätös puuttuu" }, { status: 400 });
  }
  const message = await prisma.chatMessage.findFirst({
    where: { id, userId: session.userId, role: "assistant" },
  });
  if (!message) {
    return NextResponse.json({ error: "Viestiä ei löydy" }, { status: 404 });
  }
  const proposal = message.proposalData ? JSON.parse(message.proposalData) : {};
  const next = { ...proposal, status: decision };
  const updated = await prisma.chatMessage.update({
    where: { id },
    data: { proposalData: JSON.stringify(next) },
  });
  return NextResponse.json(mapMessage(updated));
}
