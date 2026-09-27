import { Suspense } from "react";
import { SkeletonList } from "@/components/AsyncState";
import TapahtumatClient from "./TapahtumatClient";

export default function TapahtumatPage() {
  return (
    <Suspense fallback={<SkeletonList rows={4} />}>
      <TapahtumatClient />
    </Suspense>
  );
}
