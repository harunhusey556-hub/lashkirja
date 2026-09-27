/** Recurring invoice lines the user can pick onto a new invoice. */
import { prisma } from "./db";
import { NotFoundError, ValidationError } from "./api-errors";
import { centsToEuros, eurosToCents } from "./money";

function vatRateToPermille(rate: number): number {
  const permille = Math.round(rate * 10);
  if (!Number.isFinite(rate) || Math.abs(rate * 10 - permille) > 1e-6 || permille < 0) {
    throw new ValidationError("ALV-kanta on virheellinen.");
  }
  return permille;
}

export interface CatalogInput {
  name: string;
  unit?: string | null;
  unitPrice: number;
  vatRate: number;
}

export interface PublicCatalogItem {
  id: string;
  name: string;
  unit: string;
  unitPrice: number;
  vatRate: number;
}

export async function listCatalog(userId: string): Promise<PublicCatalogItem[]> {
  const rows = await prisma.catalogItem.findMany({
    where: { userId, archivedAt: null },
    orderBy: { name: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    unit: row.unit,
    unitPrice: centsToEuros(row.unitPriceCents),
    vatRate: row.vatRatePermille / 10,
  }));
}

export async function createCatalogItem(
  userId: string,
  input: CatalogInput
): Promise<PublicCatalogItem> {
  const name = input.name.trim();
  if (!name) throw new ValidationError("Tuotteen nimi puuttuu.");
  const created = await prisma.catalogItem.create({
    data: {
      userId,
      name,
      unit: input.unit?.trim() || "kpl",
      unitPriceCents: eurosToCents(input.unitPrice),
      vatRatePermille: vatRateToPermille(input.vatRate),
    },
  });
  return {
    id: created.id,
    name: created.name,
    unit: created.unit,
    unitPrice: centsToEuros(created.unitPriceCents),
    vatRate: created.vatRatePermille / 10,
  };
}

export async function archiveCatalogItem(userId: string, id: string): Promise<void> {
  const existing = await prisma.catalogItem.findFirst({ where: { id, userId } });
  if (!existing) throw new NotFoundError("Tuotetta ei löytynyt.");
  await prisma.catalogItem.update({ where: { id }, data: { archivedAt: new Date() } });
}
