"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ErrorState } from "@/components/AsyncState";
import ReceiptEditor from "@/components/ReceiptEditor";
import { ReceiptDetailSkeleton } from "@/components/books/Skeletons";

export default function Page() {
  return (
    <Suspense fallback={<ReceiptDetailSkeleton />}>
      <ReceiptDetail />
    </Suspense>
  );
}

function ReceiptDetail() {
  const id = useSearchParams().get("id");

  if (!id) {
    return <ErrorState title="Kuittia ei löytynyt" message="Kuitti on voitu poistaa." />;
  }

  return <ReceiptEditor receiptId={id} />;
}
