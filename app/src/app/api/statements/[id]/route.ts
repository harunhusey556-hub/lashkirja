import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { getStatementForUser } from "@/lib/statement-api";
import { removeUserUpload } from "@/lib/storage";
import * as path from "path";

const patchSchema = z.object({
  periodMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Muoto: YYYY-MM"),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const { id } = await params;
  const statement = await getStatementForUser(session.userId!, id);
  if (!statement) {
    return NextResponse.json(
      { error: "Tiliotetta ei löytynyt" },
      { status: 404 }
    );
  }

  return NextResponse.json({ statement });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Virheellinen kuukausi (YYYY-MM)" },
      { status: 400 }
    );
  }

  const statement = await prisma.statement.findFirst({
    where: { id, userId: session.userId },
  });
  if (!statement) {
    return NextResponse.json(
      { error: "Tiliotetta ei löytynyt" },
      { status: 404 }
    );
  }

  const updated = await prisma.statement.update({
    where: { id },
    data: { periodMonth: parsed.data.periodMonth, periodSource: "manual" },
  });

  return NextResponse.json({ ok: true, statement: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const { id } = await params;
  const statement = await prisma.statement.findFirst({
    where: { id, userId: session.userId },
  });
  if (!statement) {
    return NextResponse.json(
      { error: "Tiliotetta ei löytynyt" },
      { status: 404 }
    );
  }

  // Transactions are removed via onDelete: Cascade
  await prisma.statement.delete({ where: { id } });

  // allowLegacy: statements uploaded before per-user storage landed still carry
  // a flat data/uploads/<uuid>.<ext> path.
  try {
    await removeUserUpload(session.userId, path.basename(statement.filePath), true);
  } catch {
    // file already gone or unreadable — DB row removal is what matters
  }

  return NextResponse.json({ ok: true });
}
