import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { processAiChatMessage } from "@/lib/ai-assistant";

import { errorText } from "@/lib/api-errors";
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
    const { message } = await req.json();
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

    return NextResponse.json({
      id: assistantMsg.id,
      role: "assistant",
      content: reply,
      proposal: proposal || null,
      createdAt: assistantMsg.createdAt,
    });
  } catch (error: unknown) {
    console.error("🔥 AI Chat API Error:", error);
    return NextResponse.json(
      { error: errorText(error, "AI-apurin virhe") },
      { status: 500 }
    );
  }
}
