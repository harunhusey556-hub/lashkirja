/**
 * Account close, data-copy, and mail-recovery requests.
 *
 * Completing a close request sets User.accessDisabledAt, revokes sessions,
 * ends the bank consents at the bank, stops recurring schedules and purges what
 * is not accounting material (mailbox credential, assistant conversations,
 * bank secrets, phone). Receipts and invoices stay. Completing an export writes a zip the user can
 * download. A recovery row is queued when a reset link could not be mailed.
 */
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/db";
import { revokeAuthSessions } from "@/lib/account-security";
import { toCsv, type CsvValue } from "@/lib/csv";
import { buildStoredZip } from "@/lib/zip-store";
import { readUserUpload, safeOriginalName } from "@/lib/storage";
import { ACCOUNTING_RETENTION_YEARS } from "@/lib/session-policy";
import { revokeBankConnection } from "@/lib/enablebanking/connect";
import type { EnableBankingClient } from "@/lib/enablebanking/client";

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

const COPY_FILE_KEY = /^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/;

function jsonEntry(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

/**
 * The data copy: everything the Tietosuoja page says the account holds, as
 * JSON (one file per kind, all columns) plus the three CSV overviews and the
 * receipt files. Left out on purpose and said in lue-minut.txt: the password
 * hash, the mailbox password and the bank connection's secrets.
 */
export async function buildAccountCopyZip(userId: string): Promise<Buffer> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    omit: { passwordHash: true, legacySessionsRevokedAt: true },
  });
  if (!user) throw new AccountRequestError("Ei käyttäjää", 404);
  const byUser = { where: { userId } };
  const [
    customers,
    invoices,
    purchaseInvoices,
    receipts,
    statements,
    transactions,
    bankAccounts,
    bankConnections,
    vatFilings,
    recurring,
    catalog,
    mailboxes,
    conversations,
  ] = await Promise.all([
    prisma.customer.findMany({ ...byUser, orderBy: { name: "asc" } }),
    prisma.salesInvoice.findMany({
      ...byUser,
      orderBy: { number: "asc" },
      include: { lines: true, payments: true, reminders: true, emailSends: true, activities: true },
    }),
    prisma.purchaseInvoice.findMany({ ...byUser, orderBy: { createdAt: "asc" }, include: { payments: true } }),
    prisma.receipt.findMany({ ...byUser, orderBy: { createdAt: "asc" } }),
    prisma.statement.findMany({ ...byUser, orderBy: { id: "asc" } }),
    prisma.transaction.findMany({ where: { statement: { userId } }, orderBy: { createdAt: "asc" } }),
    prisma.bankAccount.findMany({ ...byUser, orderBy: { createdAt: "asc" }, include: { monthlyBalances: true } }),
    prisma.bankConnection.findMany({
      ...byUser,
      orderBy: { createdAt: "asc" },
      omit: { sessionIdEnc: true, authStateHash: true },
      include: { accounts: true },
    }),
    prisma.vatFiling.findMany({ ...byUser }),
    prisma.recurringInvoice.findMany({ ...byUser, include: { lines: true, runs: true } }),
    prisma.catalogItem.findMany({ ...byUser }),
    prisma.imapAccount.findMany({ ...byUser, omit: { encryptedPass: true } }),
    prisma.conversation.findMany({
      ...byUser,
      orderBy: { createdAt: "asc" },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    }),
  ]);

  const jsonFiles: Array<[string, unknown[] | object]> = [
    ["profiili.json", user],
    ["asiakkaat.json", customers],
    ["laskut.json", invoices],
    ["ostolaskut.json", purchaseInvoices],
    ["kuitit.json", receipts],
    ["tiliotteet.json", statements],
    ["pankkitapahtumat.json", transactions],
    ["pankkitilit.json", bankAccounts],
    ["pankkiyhteydet.json", bankConnections],
    ["alv-ilmoitukset.json", vatFilings],
    ["toistuvat-laskut.json", recurring],
    ["tuotteet.json", catalog],
    ["postilaatikko.json", mailboxes],
    ["avustaja.json", conversations],
  ];

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

  const entries: Array<{ name: string; data: Buffer }> = [];
  for (const [name, value] of jsonFiles) entries.push({ name, data: jsonEntry(value) });
  entries.push(
    { name: "asiakkaat.csv", data: Buffer.from(toCsv(["nimi", "sahkoposti", "ytunnus", "tila"], customerRows), "utf8") },
    { name: "laskut.csv", data: Buffer.from(toCsv(["numero", "tila", "paiva", "summa"], invoiceRows), "utf8") },
    {
      name: "kuitit.csv",
      data: Buffer.from(toCsv(["myyja", "paiva", "summa", "kategoria", "tiedosto"], receiptRows), "utf8"),
    }
  );

  // The receipt files themselves, with a list of any that could not be read.
  const missingFiles: string[] = [];
  const usedNames = new Set<string>();
  for (const receipt of receipts) {
    if (!COPY_FILE_KEY.test(receipt.filePath)) {
      missingFiles.push(`${receipt.fileName}: tiedostoa ei ole tallennettu palvelimelle`);
      continue;
    }
    try {
      const bytes = await readUserUpload(userId, receipt.filePath);
      const base = safeOriginalName(receipt.fileName || "kuitti");
      let name = `kuitit/${base}`;
      for (let n = 2; usedNames.has(name); n += 1) name = `kuitit/${n}-${base}`;
      usedNames.add(name);
      entries.push({ name, data: bytes });
    } catch {
      missingFiles.push(`${receipt.fileName}: tiedostoa ei löytynyt`);
    }
  }
  if (missingFiles.length > 0) {
    entries.push({ name: "kuitit/puuttuvat.txt", data: Buffer.from(missingFiles.join("\n"), "utf8") });
  }

  const counts = jsonFiles
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .map(([name, rows]) => `${name}: ${rows.length}`);
  const readme =
    `LashKirjan tietokopio.\n\n` +
    `Tässä ovat tilisi tiedot: profiili ja laskutustiedot, asiakkaat, myynti- ja ostolaskut, maksut, kuitit ja niiden tiedostot, ` +
    `tiliotteet ja pankkitapahtumat, pankkitilit ja pankkiyhteydet, ALV-ilmoitukset, toistuvat laskut, tuotteet, ` +
    `yhdistetyn postilaatikon tiedot ja keskustelut avustajan kanssa. Jokainen tieto on JSON-tiedostossa; ` +
    `laskut, asiakkaat ja kuitit ovat lisäksi csv-yhteenvetona.\n\n` +
    `Mukana ei ole salasanasi tiivistettä, postilaatikon salasanaa eikä pankkiyhteyden salaisuuksia. ` +
    `Tiliotteiden alkuperäisiä tiedostoja ei ole mukana, mutta niiden rivit ovat tiedostossa pankkitapahtumat.json.\n` +
    `Kirjanpitoaineistoa säilytetään ${ACCOUNTING_RETENTION_YEARS} vuotta.\n\n` +
    `Rivejä tiedostoissa:\n` +
    counts.join("\n") +
    `\nkuitit/ (kuittien tiedostot): ${usedNames.size}\n`;
  entries.unshift({ name: "lue-minut.txt", data: Buffer.from(readme, "utf8") });
  return buildStoredZip(entries);
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

/**
 * Ends each of the owner's bank consents at the bank (F57), because wiping the
 * session id locally would leave the consent live until its valid_until with
 * nothing in the app able to revoke it. A bank that does not answer must not
 * keep the account open, so a failure is returned for the request note and the
 * local wipe goes on. Names of the banks whose consent was not ended.
 */
async function endBankConsents(userId: string, client?: EnableBankingClient): Promise<string[]> {
  const connections = await prisma.bankConnection.findMany({
    where: { userId, sessionIdEnc: { not: null }, status: { not: "revoked" } },
    select: { id: true, aspspName: true },
    orderBy: { createdAt: "asc" },
  });
  const left: string[] = [];
  for (const connection of connections) {
    try {
      await revokeBankConnection(userId, connection.id, null, client);
    } catch (error) {
      console.error("Account close: bank consent was not ended at the bank", {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : "unknown",
      });
      left.push(connection.aspspName);
    }
  }
  return left;
}

export async function completeAccountClose(id: string, options: { bankClient?: EnableBankingClient } = {}) {
  const row = await requireOpen(id);
  if (row.kind !== "close") {
    throw new AccountRequestError("Sulkeminen koskee vain sulkemispyyntöä.", 400);
  }
  const now = new Date();
  const consentsLeft = await endBankConsents(row.userId, options.bankClient);
  const consentNote = consentsLeft.length
    ? `Pankin suostumusta ei saatu päätettyä pankissa: ${consentsLeft.join(", ")}. Se päättyy itsestään tai omassa pankkisovelluksessa.`
    : null;
  // What is purged and what stays (F57). Receipts, invoices, statements, bank
  // rows, customers and the seller details printed on invoices are accounting
  // records and stay for the retention period. The mailbox connection and its
  // password, the assistant conversations, the bank connection's secrets, the
  // phone number and the onboarding answers are not part of any retained
  // document and go now.
  await prisma.$transaction([
    prisma.imapAccount.deleteMany({ where: { userId: row.userId } }),
    prisma.chatMessage.deleteMany({ where: { userId: row.userId } }),
    prisma.conversation.deleteMany({ where: { userId: row.userId } }),
    prisma.bankConnection.updateMany({
      where: { userId: row.userId },
      // lastError goes too: a revoked row that keeps it is later shown as an
      // expired bank card.
      data: { sessionIdEnc: null, authStateHash: null, status: "revoked", lastError: null },
    }),
    // A closed account bills no one: its schedules stop with it.
    prisma.recurringInvoice.updateMany({ where: { userId: row.userId }, data: { active: false } }),
    prisma.user.update({
      where: { id: row.userId },
      data: { accessDisabledAt: now, phone: null, businessDetails: null, pendingEmail: null },
    }),
    prisma.accountToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: now } }),
    prisma.accountRequest.update({
      where: { id: row.id },
      data: {
        status: "completed",
        resolvedAt: now,
        ...(consentNote ? { note: row.note ? `${row.note}\n${consentNote}` : consentNote } : {}),
      },
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
