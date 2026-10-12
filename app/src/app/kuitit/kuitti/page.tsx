"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ErrorState } from "@/components/AsyncState";
import ReceiptEditor from "@/components/ReceiptEditor";
import { ReceiptDetailSkeleton } from "@/components/books/Skeletons";
import { recallReceiptRow } from "@/lib/receipt-row-seed";
import type { SavedReceipt } from "../types";

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

  // Opened from the Kuitit list: its row names the receipt while the full one loads.
  return <ReceiptEditor receiptId={id} seed={recallReceiptRow<SavedReceipt>(id)} />;
}
