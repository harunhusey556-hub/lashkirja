import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { ImapFlow } from "imapflow";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { z } from "zod";
import { withErrorHandler, AppError } from "@/lib/api-errors";

import { errorText } from "@/lib/api-errors";
const connectSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  host: z.string().min(1).default("imap.gmail.com"),
  port: z.number().int().default(993),
  tls: z.boolean().default(true),
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const json = await req.json();
  const parsed = connectSchema.parse(json);

  const client = new ImapFlow({
    host: parsed.host,
    port: parsed.port,
    secure: parsed.tls,
    auth: {
      user: parsed.email,
      pass: parsed.password,
    },
    logger: false,
  });

  try {
    await client.connect();
    await client.logout();
  } catch (error: unknown) {
    throw new AppError(
      `Yhdistäminen epäonnistui: ${errorText(error, "Tarkista sähköposti ja sovellussalasana")}`,
      "IMAP_CONNECTION_FAILED",
      400
    );
  }

  const account = await prisma.imapAccount.create({
    data: {
      userId: session.userId,
      email: parsed.email,
      host: parsed.host,
      port: parsed.port,
      tls: parsed.tls,
      encryptedPass: encrypt(parsed.password),
    },
  });

  return NextResponse.json({ success: true, email: account.email });
});

export const DELETE = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("id");

  if (!accountId) {
    throw new AppError("Tilin ID puuttuu", "MISSING_ACCOUNT_ID", 400);
  }

  await prisma.imapAccount.delete({
    where: { 
      id: accountId,
      userId: session.userId 
    },
  });

  return NextResponse.json({ success: true });
});
