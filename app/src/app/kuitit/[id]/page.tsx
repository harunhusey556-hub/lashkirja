"use client";

import { use, Suspense } from "react";
import ReceiptEditor from "@/components/ReceiptEditor";

export default function MuokkaaKuittiaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <>
      <Suspense fallback={null}>
        <ReceiptEditor receiptId={id} />
      </Suspense>
    </>
  );
}
