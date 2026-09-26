import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { processAiChatMessage } from "@/lib/ai-assistant";

import { errorText } from "@/lib/api-errors";

function chunkReply(reply: string): string[] {
  if (!reply) return [""];
  const parts = reply.split(/(\s+)/);
  const chunks: string[] = [];
  let current = "";
  for (const part of parts) {
    current += part;
    if (current.length >= 48) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [reply];
}

export async function GET() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const messages = await prisma.chatMessage.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  return NextResponse.json({
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      proposal: m.proposalData ? JSON.parse(m.proposalData) : null,
      createdAt: m.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  try {
    const { message, stream } = await req.json();
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return NextResponse.json(
        { error: "Viesti on pakollinen" },
        { status: 400 }
      );
    }

    // Save user message
    await prisma.chatMessage.create({
      data: {
        userId: session.userId,
        role: "user",
        content: message.trim(),
      },
    });

    // Process with AI assistant
    const { reply, proposal } = await processAiChatMessage(
      session.userId,
      message.trim()
    );

    // Save assistant reply
    const assistantMsg = await prisma.chatMessage.create({
      data: {
        userId: session.userId,
        role: "assistant",
        content: reply,
        proposalData: proposal ? JSON.stringify(proposal) : null,
      },
    });

    const payload = {
      id: assistantMsg.id,
      role: "assistant" as const,
      content: reply,
      proposal: proposal || null,
      createdAt: assistantMsg.createdAt,
    };

    // The model call finishes before this response. Streaming chunks the
    // finished reply so the drawer can paint it as it arrives, then a done
    // event carries the saved id and any match proposal.
    if (stream === true) {
      const encoder = new TextEncoder();
      const streamBody = new ReadableStream({
        async start(controller) {
          for (const delta of chunkReply(reply)) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
            await new Promise((resolve) => setTimeout(resolve, 12));
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                done: true,
                id: payload.id,
                proposal: payload.proposal,
                createdAt: payload.createdAt,
              })}\n\n`
            )
          );
          controller.close();
        },
      });
      return new Response(streamBody, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      });
    }

    return NextResponse.json(payload);
  } catch (error: unknown) {
    console.error("🔥 AI Chat API Error:", errorText(error));
    return NextResponse.json(
      { error: "Tekoälyapurin käsittely epäonnistui. Yritä hetken kuluttua uudelleen." },
      { status: 500 }
    );
  }
}
