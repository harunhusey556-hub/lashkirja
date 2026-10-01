/**
 * Text search for the lists (customers, invoices, receipts).
 *
 * SQLite LIKE folds the case of ASCII letters only and treats % and _ as
 * wildcards, so the lists filter in memory with these helpers instead:
 * 'äiti', 'Äiti' and 'ÄITI' are one word, Turkish letters fold the same way,
 * and a typed % or _ only matches a text that contains it.
 */

/** Lower-cases for comparison: Finnish and Turkish letters, no dotted-i leftovers. */
export function normalizeSearch(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/\u0307/g, "") // the combining dot that "İ" leaves behind
    .replace(/\u0131/g, "i") // Turkish dotless i
    .trim();
}

/** True when the query is empty or any of the fields contains it (literal match). */
export function matchesSearch(
  query: string | null | undefined,
  fields: Array<string | null | undefined>
): boolean {
  const needle = normalizeSearch(query);
  if (!needle) return true;
  return fields.some((field) => normalizeSearch(field).includes(needle));
}

/** Fields a customer is found by: name, contact, e-mail and Y-tunnus with and without the dash. */
export function customerSearchFields(customer: {
  name: string;
  contactPerson?: string | null;
  email?: string | null;
  businessId?: string | null;
}): string[] {
  const fields = [customer.name, customer.contactPerson ?? "", customer.email ?? ""];
  if (customer.businessId) {
    fields.push(customer.businessId, customer.businessId.replace(/-/g, ""));
  }
  return fields;
}
