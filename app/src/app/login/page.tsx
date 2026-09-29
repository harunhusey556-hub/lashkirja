import { Suspense } from "react";
import { BareCardSkeleton, BareFrame } from "@/components/BareFrame";
import LoginForm from "./LoginForm";

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        // The card at its final size, not a spinner in empty space (L1, VS-33).
        <BareFrame>
          <BareCardSkeleton />
        </BareFrame>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
