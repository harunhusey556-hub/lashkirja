import { Suspense } from "react";
import LoginForm from "./LoginForm";

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="h-dvh flex items-center justify-center bg-canvas">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin motion-reduce:animate-none" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
