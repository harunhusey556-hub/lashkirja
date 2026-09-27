import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { requireSession } from "@/lib/session";
import { errorText } from "@/lib/api-errors";
import { DEFAULT_CONVERSATION_TITLE } from "@/lib/chat-turn";
import { createConversation, listConversations, updateConversation } from "@/lib/chat-store";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  const query = req.nextUrl.searchParams.get("q") ?? "";
  const archived = req.nextUrl.searchParams.get("archived") === "1";
  const conversations = await listConversations({ userId: session.userId, query, archived });
  return NextResponse.json({ conversations });
}

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const title = body && typeof body.title === "string" ? body.title.trim() : "";
  const conversation = await createConversation(session.userId, title || DEFAULT_CONVERSATION_TITLE);
  return NextResponse.json({
    id: conversation.id,
    title: conversation.title,
    archivedAt: conversation.archivedAt,
    createdAt: conversation.createdAt,
  });
}

export async function PATCH(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const id = body && typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "Keskustelu puuttuu" }, { status: 400 });
  const title = body && typeof body.title === "string" ? body.title : undefined;
  const archived = body && typeof body.archived === "boolean" ? body.archived : undefined;
  const deleted = body && typeof body.deleted === "boolean" ? body.deleted : undefined;
  if (title !== undefined && title.trim().length > 80) {
    return NextResponse.json({ error: "Nimi on liian pitkä" }, { status: 400 });
  }
  try {
    const updated = await updateConversation(session.userId, id, { title, archived, deleted });
    if (!updated) return NextResponse.json({ error: "Keskustelua ei löydy" }, { status: 404 });
    return NextResponse.json({
      id: updated.id,
      title: updated.title,
      archivedAt: updated.archivedAt,
      deletedAt: updated.deletedAt,
    });
  } catch (error) {
    console.error("Conversation update failed:", errorText(error));
    return NextResponse.json({ error: "Keskustelun päivitys epäonnistui" }, { status: 500 });
  }
}
