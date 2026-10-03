/**
 * Sähköpostimallit: the owner's own subject + message for an invoice e-mail.
 *
 * A template keeps placeholders ({asiakas}, {summa}, ...) and the server fills
 * them per invoice, so one text serves every customer. The mail is plain text
 * (no HTML part), so what the owner types reaches the customer as typed; the
 * cleaners below only drop control characters and keep the subject on one line,
 * so a pasted line break cannot add a mail header.
 */
import { z } from "zod";
import { prisma } from "./db";
import { ConflictError, NotFoundError } from "./api-errors";

export const TEMPLATE_KINDS = ["invoice", "reminder"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const SUBJECT_MAX = 200;
export const MESSAGE_MAX = 5000;
export const TEMPLATE_NAME_MAX = 80;
/** Enough for every real need; a runaway client cannot fill the table. */
export const TEMPLATE_LIMIT = 50;

/** The placeholders a subject or message may carry, in the order the help lists them. */
export const PLACEHOLDERS = [
  { key: "asiakas", label: "Asiakkaan nimi" },
  { key: "laskunumero", label: "Laskun numero" },
  { key: "summa", label: "Laskun summa" },
  { key: "erapaiva", label: "Eräpäivä" },
  { key: "viitenumero", label: "Viitenumero" },
  { key: "tilinumero", label: "Tilinumero (IBAN)" },
  { key: "yritys", label: "Yrityksesi nimi" },
] as const;

export type PlaceholderKey = (typeof PLACEHOLDERS)[number]["key"];
export type PlaceholderValues = Record<PlaceholderKey, string>;

const KNOWN = new Set<string>(PLACEHOLDERS.map((p) => p.key));

/** Fills `{key}` for the known keys (any letter case); anything else in braces stays as typed. */
export function renderPlaceholders(text: string, values: PlaceholderValues): string {
  return text.replace(/\{([a-zA-ZäöÄÖ]+)\}/g, (whole, name: string) => {
    const key = name.toLowerCase();
    return KNOWN.has(key) ? values[key as PlaceholderKey] : whole;
  });
}

// C0 controls and DEL; the message keeps its line breaks and tabs.
const SUBJECT_CONTROLS = /[\u0000-\u001f\u007f]+/g;
const MESSAGE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** One line: a line break becomes a space, so no header can follow the subject. */
export function cleanSubject(value: string): string {
  return value.replace(SUBJECT_CONTROLS, " ").replace(/ {2,}/g, " ").trim();
}

export function cleanMessage(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(MESSAGE_CONTROLS, "").trim();
}

export const subjectSchema = z
  .string()
  .transform(cleanSubject)
  .pipe(
    z
      .string()
      .min(1, "Aihe puuttuu.")
      .max(SUBJECT_MAX, `Aihe on liian pitkä (enintään ${SUBJECT_MAX} merkkiä).`)
  );

export const messageSchema = z
  .string()
  .transform(cleanMessage)
  .pipe(
    z
      .string()
      .min(1, "Viesti puuttuu.")
      .max(MESSAGE_MAX, `Viesti on liian pitkä (enintään ${MESSAGE_MAX} merkkiä).`)
  );

const nameSchema = z
  .string()
  .transform(cleanSubject)
  .pipe(
    z
      .string()
      .min(1, "Anna mallille nimi.")
      .max(TEMPLATE_NAME_MAX, `Nimi on liian pitkä (enintään ${TEMPLATE_NAME_MAX} merkkiä).`)
  );

const kindSchema = z.enum(TEMPLATE_KINDS, { message: "Tuntematon mallin tyyppi." });

export const createTemplateSchema = z
  .object({
    name: nameSchema,
    subject: subjectSchema,
    body: messageSchema,
    kind: kindSchema.default("invoice"),
    isDefault: z.boolean().default(false),
  })
  .strict();

export const updateTemplateSchema = z
  .object({
    name: nameSchema.optional(),
    subject: subjectSchema.optional(),
    body: messageSchema.optional(),
    kind: kindSchema.optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export type CreateTemplateInput = z.output<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.output<typeof updateTemplateSchema>;

export interface EmailTemplateView {
  id: string;
  name: string;
  subject: string;
  body: string;
  kind: TemplateKind;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

type TemplateRow = {
  id: string;
  name: string;
  subject: string;
  body: string;
  kind: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function view(row: TemplateRow): EmailTemplateView {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    body: row.body,
    kind: row.kind === "reminder" ? "reminder" : "invoice",
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The default first, then by name. */
export async function listEmailTemplates(userId: string, kind?: TemplateKind): Promise<EmailTemplateView[]> {
  const rows = await prisma.invoiceEmailTemplate.findMany({
    where: { userId, ...(kind ? { kind } : {}) },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(view);
}

export async function getEmailTemplate(userId: string, id: string): Promise<EmailTemplateView> {
  const row = await prisma.invoiceEmailTemplate.findFirst({ where: { id, userId } });
  if (!row) throw new NotFoundError("Mallia ei löytynyt.");
  return view(row);
}

export async function defaultEmailTemplate(
  userId: string,
  kind: TemplateKind = "invoice"
): Promise<EmailTemplateView | null> {
  const row = await prisma.invoiceEmailTemplate.findFirst({
    where: { userId, kind, isDefault: true },
    orderBy: { updatedAt: "desc" },
  });
  return row ? view(row) : null;
}

export async function createEmailTemplate(userId: string, input: CreateTemplateInput): Promise<EmailTemplateView> {
  const row = await prisma.$transaction(async (tx) => {
    const count = await tx.invoiceEmailTemplate.count({ where: { userId } });
    if (count >= TEMPLATE_LIMIT) {
      throw new ConflictError(`Malleja voi olla enintään ${TEMPLATE_LIMIT}. Poista jokin vanha ensin.`, "TEMPLATE_LIMIT");
    }
    // One default per kind: the new default takes the place of the old one.
    if (input.isDefault) {
      await tx.invoiceEmailTemplate.updateMany({
        where: { userId, kind: input.kind, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.invoiceEmailTemplate.create({
      data: {
        userId,
        name: input.name,
        subject: input.subject,
        body: input.body,
        kind: input.kind,
        isDefault: input.isDefault,
      },
    });
  });
  return view(row);
}

export async function updateEmailTemplate(
  userId: string,
  id: string,
  input: UpdateTemplateInput
): Promise<EmailTemplateView> {
  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.invoiceEmailTemplate.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError("Mallia ei löytynyt.");
    const kind = input.kind ?? existing.kind;
    const isDefault = input.isDefault ?? existing.isDefault;
    if (isDefault) {
      await tx.invoiceEmailTemplate.updateMany({
        where: { userId, kind, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }
    return tx.invoiceEmailTemplate.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        kind,
        isDefault,
      },
    });
  });
  return view(row);
}

export async function deleteEmailTemplate(userId: string, id: string): Promise<void> {
  const removed = await prisma.invoiceEmailTemplate.deleteMany({ where: { id, userId } });
  if (removed.count === 0) throw new NotFoundError("Mallia ei löytynyt.");
}
