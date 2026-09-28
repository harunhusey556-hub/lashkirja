"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ErrorState } from "@/components/AsyncState";
import ReceiptEditor from "@/components/ReceiptEditor";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ReceiptDetail />
    </Suspense>
  );
}

function ReceiptDetail() {
  const id = useSearchParams().get("id");

  if (!id) {
    return <ErrorState message="Kuittia ei löytynyt" />;
  }

  return <ReceiptEditor receiptId={id} />;
}
