import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { getStatementForUser } from "@/lib/statement-api";
import { removeUserUpload } from "@/lib/storage";
import * as path from "path";

import { assertMonthOpen } from "@/lib/period-lock";
import { withErrorHandler } from "@/lib/api-errors";
const patchSchema = z
  .object({
    periodMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Muoto: YYYY-MM").optional(),
    // null detaches the statement from every account.
    bankAccountId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (value) => value.periodMonth !== undefined || value.bankAccountId !== undefined,
    "Ei muutettavia kenttiä"
  );

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(req);
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

export const PATCH = withErrorHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Virheellinen pyyntö (kuukausi YYYY-MM tai pankkitilin tunnus)" },
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

  if (statement.periodMonth) {
    await assertMonthOpen(session.userId, statement.periodMonth);
  }
  if (parsed.data.periodMonth) {
    await assertMonthOpen(session.userId, parsed.data.periodMonth);
  }

  if (parsed.data.bankAccountId) {
    const account = await prisma.bankAccount.findFirst({
      where: { id: parsed.data.bankAccountId, userId: session.userId },
      select: { id: true },
    });
    if (!account) {
      return NextResponse.json(
        { error: "Pankkitiliä ei löytynyt" },
        { status: 404 }
      );
    }
  }

  const data: { periodMonth?: string; periodSource?: string; bankAccountId?: string | null } = {};
  if (parsed.data.periodMonth !== undefined) {
    data.periodMonth = parsed.data.periodMonth;
    data.periodSource = "manual";
  }
  if (parsed.data.bankAccountId !== undefined) {
    data.bankAccountId = parsed.data.bankAccountId;
  }

  const updated = await prisma.statement.update({ where: { id }, data });

  return NextResponse.json({ ok: true, statement: updated });
});

export const DELETE = withErrorHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
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

  if (statement.periodMonth) {
    await assertMonthOpen(session.userId, statement.periodMonth);
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
});
