import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { AppError, UnauthorizedError, ValidationError, withErrorHandler } from "@/lib/api-errors";
import {
  previewReminder,
  recordReminder,
  renderReminder,
  REMINDER_TERM_DAYS,
} from "@/lib/invoice-reminders";
import { findSenderAccount, sendMail } from "@/lib/mailer";
import { formatEur } from "@/lib/format";
import { formatReference } from "@/lib/finnish-reference";
import { invoicePdfFileName } from "@/lib/sales-invoices";

const bodySchema = z
  .object({
    to: z.string().trim().email().max(160).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    message: z.string().trim().max(4000).optional(),
  })
  .default({});

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const { id } = await context.params;
  return noStoreJson({ reminder: await previewReminder(session.userId, id) });
});

/**
 * Sends the reminder and records what was demanded. The record is written only
 * after the mail server accepts the message: a stored reminder must mean the
 * customer received one.
 */
export const POST = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const { id } = await context.params;
  const body = bodySchema.parse(await req.json().catch(() => ({})));

  const { buffer, preview } = await renderReminder(session.userId, id);

  const to = body.to ?? preview.recipient;
  if (!to) {
    throw new ValidationError(
      "Asiakkaalla ei ole sähköpostiosoitetta. Lisää se asiakastietoihin tai anna osoite."
    );
  }

  const account = await findSenderAccount(session.userId);
  if (!account) {
    throw new AppError(
      "Lähettävää sähköpostitiliä ei ole yhdistetty. Lisää tili asetuksista.",
      "NO_MAIL_ACCOUNT",
      409
    );
  }

  const invoiceNumber = preview.invoice.number;
  await sendMail(account, {
    to,
    subject: body.subject ?? `Maksumuistutus: lasku ${invoiceNumber}`,
    text:
      body.message ??
      [
        "Hei,",
        "",
        `laskun ${invoiceNumber} eräpäivä on ylittynyt ${preview.daysLate} päivällä.`,
        "",
        `Avoin pääoma: ${formatEur(preview.open)}`,
        ...(preview.interest > 0 ? [`Viivästyskorko: ${formatEur(preview.interest)}`] : []),
        ...(preview.fee > 0 ? [`Muistutusmaksu: ${formatEur(preview.fee)}`] : []),
        `Maksettava yhteensä: ${formatEur(preview.total)}`,
        `Viitenumero: ${formatReference(preview.invoice.reference)}`,
        `Maksettava viimeistään: ${preview.dueDate} (${REMINDER_TERM_DAYS} pv)`,
        "",
        "Jos maksu on jo matkalla, tämän viestin voi jättää huomiotta.",
      ].join("\n"),
    attachments: [
      {
        filename: `muistutus-${String(invoiceNumber).padStart(4, "0")}.pdf`,
        content: buffer,
        contentType: "application/pdf",
      },
    ],
  });

  const reminder = await recordReminder(session.userId, id, preview, { sentTo: to });

  return noStoreJson(
    {
      ok: true,
      sentTo: to,
      reminder: {
        id: reminder.id,
        level: reminder.level,
        total: preview.total,
        dueDate: preview.dueDate,
      },
      attachment: invoicePdfFileName(invoiceNumber),
    },
    { status: 201 }
  );
});
