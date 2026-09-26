"use client";

import { Suspense } from "react";
import ReceiptEditor from "@/components/ReceiptEditor";

export default function UusiKuittiPage() {
  return (
    <Suspense fallback={null}>
      <ReceiptEditor />
    </Suspense>
  );
}
