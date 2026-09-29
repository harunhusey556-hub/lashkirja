"use client";

import { Suspense } from "react";
import ReceiptEditor from "@/components/ReceiptEditor";
import { PageTitle, Skeleton, SkeletonGroup } from "@/components/ds";

/** Never a blank first frame (BOOKS-17): the title and the picker card's shape. */
function NewReceiptFallback() {
  return (
    <div className="space-y-6">
      <PageTitle title="Uusi kuitti" />
      <SkeletonGroup label="Ladataan">
        <Skeleton radius="card" className="h-80 w-full" />
      </SkeletonGroup>
    </div>
  );
}

export default function UusiKuittiPage() {
  return (
    <Suspense fallback={<NewReceiptFallback />}>
      <ReceiptEditor />
    </Suspense>
  );
}
