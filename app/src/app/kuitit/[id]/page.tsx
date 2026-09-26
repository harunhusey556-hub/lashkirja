"use client";

import { use, Suspense } from "react";
import AppShell from "@/components/AppShell";
import ReceiptEditor from "@/components/ReceiptEditor";

export default function MuokkaaKuittiaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <AppShell>
      <Suspense fallback={null}>
        <ReceiptEditor receiptId={id} />
      </Suspense>
    </AppShell>
  );
}
