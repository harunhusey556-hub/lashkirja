import { Suspense } from "react";
import { LoadingState } from "@/components/AsyncState";
import StatementDetailClient from "./StatementDetailClient";

export default function StatementDetailPage() {
  return (
    <Suspense fallback={<LoadingState label="Ladataan tiliotetta..." compact />}>
      <StatementDetailClient />
    </Suspense>
  );
}
