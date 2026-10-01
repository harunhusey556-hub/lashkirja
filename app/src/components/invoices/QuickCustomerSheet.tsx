"use client";

import { useRef, useState } from "react";
import BottomSheet from "@/components/BottomSheet";
import { apiFetch, readJson } from "@/components/clientFetch";
import { CustomerForm, type CustomerFormPayload } from "@/components/invoices/CustomerForm";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { showToast } from "@/lib/toast";

export interface CreatedCustomer {
  id: string;
  name: string;
  defaultPaymentTermDays: number;
}

/**
 * "Uusi asiakas" in a sheet, for forms that need a customer (SALES-09): the
 * user never has to leave a half-written invoice to add one. The form's own
 * draft and the sheet's dirty guard protect what was typed.
 */
export function QuickCustomerSheet({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (customer: CreatedCustomer) => void;
}) {
  const [busy, setBusy] = useState(false);
  const createKey = useRef(newIdempotencyKey());

  async function submit(payload: CustomerFormPayload) {
    setBusy(true);
    try {
      const response = await apiFetch("/api/customers", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "Idempotency-Key": createKey.current },
        body: JSON.stringify(payload),
      });
      const data = await readJson<{ customer: CreatedCustomer }>(response, "Asiakkaan lisäys epäonnistui");
      createKey.current = newIdempotencyKey();
      showToast({ tone: "success", text: `${data.customer.name} lisättiin` });
      onCreated(data.customer);
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title="Uusi asiakas"
      labelledBy="quick-customer-title"
      heightClass="max-h-[92dvh]"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 sheet-safe-bottom">
        <CustomerForm
          key={isOpen ? "quick-open" : "quick-closed"}
          draftKey="customer:quick"
          submitLabel="Lisää asiakas"
          busy={busy}
          onSubmit={submit}
          onSaved={onClose}
          onCancel={onClose}
        />
      </div>
    </BottomSheet>
  );
}
