import { prisma } from "./db";

/** Stable key for “this vendor later”. Display names collapse to the same rule. */
export function normalizeVendorKey(vendor: string): string {
  return vendor.trim().toLocaleLowerCase("fi-FI").replace(/\s+/g, " ").slice(0, 200);
}

export async function findActiveVendorRule(userId: string, vendor: string) {
  const key = normalizeVendorKey(vendor);
  if (!key) return null;
  return prisma.vendorCategoryRule.findUnique({
    where: { userId_vendor: { userId, vendor: key } },
  });
}

export async function saveVendorRule(userId: string, vendor: string, category: string) {
  const key = normalizeVendorKey(vendor);
  const trimmed = category.trim().slice(0, 100);
  if (!key) throw new Error("Myyjä puuttuu");
  if (!trimmed) throw new Error("Kategoria puuttuu");
  return prisma.vendorCategoryRule.upsert({
    where: { userId_vendor: { userId, vendor: key } },
    create: { userId, vendor: key, category: trimmed, active: true },
    update: { category: trimmed, active: true, undoneAt: null },
  });
}

export async function undoVendorRule(userId: string, vendor: string) {
  const key = normalizeVendorKey(vendor);
  if (!key) return null;
  const existing = await prisma.vendorCategoryRule.findUnique({
    where: { userId_vendor: { userId, vendor: key } },
  });
  if (!existing) return null;
  return prisma.vendorCategoryRule.update({
    where: { id: existing.id },
    data: { active: false, undoneAt: new Date() },
  });
}
