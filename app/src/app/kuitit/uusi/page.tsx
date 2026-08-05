"use client";

import { Suspense } from "react";
import AppShell from "@/components/AppShell";
import ReceiptEditor from "@/components/ReceiptEditor";

export default function UusiKuittiPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <ReceiptEditor />
      </Suspense>
    </AppShell>
  );
}
