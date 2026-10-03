import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, ValidationError, withErrorHandler } from "@/lib/api-errors";
import {
  createEmailTemplate,
  createTemplateSchema,
  listEmailTemplates,
  PLACEHOLDERS,
  TEMPLATE_KINDS,
  type TemplateKind,
} from "@/lib/invoice-email-templates";

/**
 * Sähköpostimallit.
 *
 * GET `?kind=invoice|reminder` (optional) -> `{ templates, placeholders }`, the
 * default first. `placeholders` lists `{ key, label }` for the help text.
 *
 * POST `{ name, subject, body, kind?: "invoice" | "reminder", isDefault?: boolean }`
 * -> 201 `{ template }`. Subject max 200 characters on one line, body max 5000,
 * plain text. The placeholders {asiakas}, {laskunumero}, {summa}, {erapaiva},
 * {viitenumero}, {tilinumero} and {yritys} are kept as typed and filled per
 * invoice when sent. A new default replaces the old default of the same kind.
 */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const raw = req.nextUrl.searchParams.get("kind");
  if (raw !== null && !(TEMPLATE_KINDS as readonly string[]).includes(raw)) {
    throw new ValidationError("Tuntematon mallin tyyppi.");
  }
  return noStoreJson({
    templates: await listEmailTemplates(session.userId, (raw as TemplateKind | null) ?? undefined),
    placeholders: PLACEHOLDERS,
  });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;
  const template = await createEmailTemplate(session.userId, createTemplateSchema.parse(await req.json()));
  return noStoreJson({ template }, { status: 201 });
});
