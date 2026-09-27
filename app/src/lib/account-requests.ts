/**
 * Account close, data-copy, and mail-recovery requests.
 *
 * Completing a close request sets User.accessDisabledAt and revokes sessions.
 * Receipts and invoices stay. Completing an export writes a zip the user can
 * download. A recovery row is queued when a reset link could not be mailed.
 */
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/db";
import { revokeAuthSessions } from "@/lib/account-security";
import { toCsv, type CsvValue } from "@/lib/csv";
import { buildStoredZip } from "@/lib/zip-store";
import { ACCOUNTING_RETENTION_YEARS } from "@/lib/session-policy";

export const ACCOUNT_REQUEST_STATUSES = [
  "pending",
  "in_progress",
  "needs_info",
  "completed",
  "denied",
] as const;

export type AccountRequestStatus = (typeof ACCOUNT_REQUEST_STATUSES)[number];

const OPEN_STATUSES = new Set<AccountRequestStatus>(["pending", "in_progress", "needs_info"]);

export class AccountRequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AccountRequestError";
    this.status = status;
  }
}

export function accountRequestStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Odottaa";
    case "in_progress":
      return "Käsittelyssä";
    case "needs_info":
      return "Tarvitaan lisätieto";
    case "completed":
      return "Valmis";
    case "denied":
      return "Hylätty";
    default:
      return "Odottaa";
  }
}

export function accountRequestKindLabel(kind: string): string {
  if (kind === "close") return "Tilin sulkeminen";
  if (kind === "export") return "Tietojen kopio";
  if (kind === "recovery") return "Salasanan palautus";
  return kind;
}

export function accountPackageDir(): string {
  return path.join(process.cwd(), "data", "account-packages");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Relative path stored on the row. Only this shape is served. */
export function accountPackageRelative(userId: string, requestId: string): string {
  if (!isUuid(userId) || !isUuid(requestId)) {
    throw new AccountRequestError("Paketin polku ei kelpaa.", 400);
  }
  return path.posix.join(userId, `${requestId}.zip`);
}

export function resolveAccountPackage(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.includes("..") || path.isAbsolute(normalized)) {
    throw new AccountRequestError("Paketin polku ei kelpaa.", 400);
  }
  const absolute = path.resolve(accountPackageDir(), normalized);
  const root = path.resolve(accountPackageDir());
  if (!absolute.startsWith(root + path.sep)) {
    throw new AccountRequestError("Paketin polku ei kelpaa.", 400);
  }
  return absolute;
}

export async function listUserAccountRequests(userId: string) {
  const rows = await prisma.accountRequest.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      kind: true,
      status: true,
      note: true,
      packagePath: true,
      createdAt: true,
      updatedAt: true,
      resolvedAt: true,
    },
  });
  return rows.map((row) => ({
    ...row,
    statusLabel: accountRequestStatusLabel(row.status),
    kindLabel: accountRequestKindLabel(row.kind),
    downloadable: row.kind === "export" && row.status === "completed" && Boolean(row.packagePath),
  }));
}

/** One open recovery row per user. Called when reset mail could not be sent. */
export async function queueRecoveryRequest(userId: string) {
  const open = await prisma.accountRequest.findFirst({
    where: { userId, kind: "recovery", status: { in: [...OPEN_STATUSES] } },
    select: { id: true, status: true },
  });
  if (open) return open;
  return prisma.accountRequest.create({
    data: { userId, kind: "recovery", status: "pending" },
    select: { id: true, status: true },
  });
}

async function requireOpen(id: string) {
  const row = await prisma.accountRequest.findUnique({ where: { id } });
  if (!row) throw new AccountRequestError("Pyyntöä ei löydy.", 404);
  if (!OPEN_STATUSES.has(row.status as AccountRequestStatus)) {
    throw new AccountRequestError("Pyyntö on jo päätetty.", 409);
  }
  return row;
}

export async function setAccountRequestStatus(id: string, status: AccountRequestStatus, note?: string) {
  if (!ACCOUNT_REQUEST_STATUSES.includes(status)) {
    throw new AccountRequestError("Tila ei kelpaa.", 400);
  }
  const row = await requireOpen(id);
  if (status === "completed" && row.kind !== "recovery") {
    throw new AccountRequestError("Valmis-tila vaatii viennin tai sulkemisen komennon.", 400);
  }
  const now = new Date();
  return prisma.accountRequest.update({
    where: { id },
    data: {
      status,
      ...(note !== undefined ? { note } : {}),
      ...(status === "completed" || status === "denied" ? { resolvedAt: now } : { resolvedAt: null }),
    },
  });
}

export async function buildAccountCopyZip(userId: string): Promise<Buffer> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      firstName: true,
      lastName: true,
      entityType: true,
      businessName: true,
      businessId: true,
      createdAt: true,
    },
  });
  if (!user) throw new AccountRequestError("Ei käyttäjää", 404);
  const [customers, invoices, receipts] = await Promise.all([
    prisma.customer.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: { name: true, email: true, businessId: true, archivedAt: true },
    }),
    prisma.salesInvoice.findMany({
      where: { userId },
      orderBy: { number: "asc" },
      select: { number: true, status: true, issueDate: true, grossCents: true },
    }),
    prisma.receipt.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { vendor: true, date: true, totalAmountCents: true, fileName: true, category: true },
    }),
  ]);
  const readme =
    `LashKirjan tietokopio.\n` +
    `Kirjanpitoaineistoa säilytetään ${ACCOUNTING_RETENTION_YEARS} vuotta. ` +
    `Tämä paketti ei sisällä salasanaa, sähköpostin salasanaa eikä pankkiyhteyden salaisuuksia.\n`;
  const customerRows: CsvValue[][] = customers.map((row) => [
    row.name,
    row.email,
    row.businessId,
    row.archivedAt ? "arkistoitu" : "aktiivinen",
  ]);
  const invoiceRows: CsvValue[][] = invoices.map((row) => [
    row.number,
    row.status,
    row.issueDate.toISOString().slice(0, 10),
    (row.grossCents / 100).toFixed(2).replace(".", ","),
  ]);
  const receiptRows: CsvValue[][] = receipts.map((row) => [
    row.vendor,
    row.date ? row.date.toISOString().slice(0, 10) : "",
    row.totalAmountCents == null ? "" : (row.totalAmountCents / 100).toFixed(2).replace(".", ","),
    row.category,
    row.fileName,
  ]);
  return buildStoredZip([
    { name: "lue-minut.txt", data: Buffer.from(readme, "utf8") },
    {
      name: "profiili.json",
      data: Buffer.from(JSON.stringify(user, null, 2), "utf8"),
    },
    {
      name: "asiakkaat.csv",
      data: Buffer.from(toCsv(["nimi", "sahkoposti", "ytunnus", "tila"], customerRows), "utf8"),
    },
    {
      name: "laskut.csv",
      data: Buffer.from(toCsv(["numero", "tila", "paiva", "summa"], invoiceRows), "utf8"),
    },
    {
      name: "kuitit.csv",
      data: Buffer.from(toCsv(["myyja", "paiva", "summa", "kategoria", "tiedosto"], receiptRows), "utf8"),
    },
  ]);
}

export async function completeAccountExport(id: string) {
  const row = await requireOpen(id);
  if (row.kind !== "export") {
    throw new AccountRequestError("Vienti koskee vain kopiopyyntöä.", 400);
  }
  const relative = accountPackageRelative(row.userId, row.id);
  const absolute = resolveAccountPackage(relative);
  const bytes = await buildAccountCopyZip(row.userId);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  return prisma.accountRequest.update({
    where: { id: row.id },
    data: { status: "completed", packagePath: relative, resolvedAt: new Date() },
  });
}

export async function completeAccountClose(id: string) {
  const row = await requireOpen(id);
  if (row.kind !== "close") {
    throw new AccountRequestError("Sulkeminen koskee vain sulkemispyyntöä.", 400);
  }
  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({
      where: { id: row.userId },
      data: { accessDisabledAt: now },
    }),
    prisma.accountRequest.update({
      where: { id: row.id },
      data: { status: "completed", resolvedAt: now },
    }),
  ]);
  await revokeAuthSessions(row.userId);
  return prisma.accountRequest.findUniqueOrThrow({ where: { id: row.id } });
}

export async function readAccountPackageForUser(userId: string, requestId: string): Promise<Buffer> {
  const row = await prisma.accountRequest.findFirst({
    where: { id: requestId, userId },
    select: { kind: true, status: true, packagePath: true },
  });
  if (!row || row.kind !== "export" || row.status !== "completed" || !row.packagePath) {
    throw new AccountRequestError("Pakettia ei ole.", 404);
  }
  const expected = accountPackageRelative(userId, requestId);
  if (row.packagePath !== expected) {
    throw new AccountRequestError("Pakettia ei ole.", 404);
  }
  return readFile(resolveAccountPackage(expected));
}
