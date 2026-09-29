import { Suspense } from "react";
import { StatementDetailSkeleton } from "@/components/books/Skeletons";
import StatementDetailClient from "./StatementDetailClient";

export default function StatementDetailPage() {
  return (
    <Suspense fallback={<StatementDetailSkeleton />}>
      <StatementDetailClient />
    </Suspense>
  );
}
